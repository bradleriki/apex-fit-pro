package pro.apexfit.app;

import android.os.Looper;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.samsung.android.sdk.health.data.HealthDataService;
import com.samsung.android.sdk.health.data.HealthDataStore;
import com.samsung.android.sdk.health.data.data.AggregatedData;
import com.samsung.android.sdk.health.data.data.HealthDataPoint;
import com.samsung.android.sdk.health.data.data.entries.HeartRate;
import com.samsung.android.sdk.health.data.error.HealthDataException;
import com.samsung.android.sdk.health.data.error.ResolvablePlatformException;
import com.samsung.android.sdk.health.data.permission.AccessType;
import com.samsung.android.sdk.health.data.permission.Permission;
import com.samsung.android.sdk.health.data.request.AggregateRequest;
import com.samsung.android.sdk.health.data.request.DataType;
import com.samsung.android.sdk.health.data.request.DataTypes;
import com.samsung.android.sdk.health.data.request.LocalTimeFilter;
import com.samsung.android.sdk.health.data.request.LocalTimeGroup;
import com.samsung.android.sdk.health.data.request.LocalTimeGroupUnit;
import com.samsung.android.sdk.health.data.request.Ordering;
import com.samsung.android.sdk.health.data.request.ReadDataRequest;
import com.samsung.android.sdk.health.data.response.DataResponse;

import java.time.Duration;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Reads steps, activity, heart rate and sleep straight from Samsung Health
 * (Samsung Health Data SDK), so the app doesn't depend on Google Fit or Health Connect.
 *
 * JS: registerPlugin("SamsungHealth") → status(), requestAccess(), readSummary()
 */
@CapacitorPlugin(name = "SamsungHealth")
public class SamsungHealthPlugin extends Plugin {

    private static final int WEEK_DAYS = 7;
    private static final int MAX_PAGES = 30;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private HealthDataStore store;

    private HealthDataStore store() {
        if (store == null) store = HealthDataService.getStore(getContext());
        return store;
    }

    private static Set<Permission> permissions() {
        Set<Permission> set = new HashSet<>();
        set.add(Permission.of(DataTypes.STEPS, AccessType.READ));
        set.add(Permission.of(DataTypes.ACTIVITY_SUMMARY, AccessType.READ));
        set.add(Permission.of(DataTypes.HEART_RATE, AccessType.READ));
        set.add(Permission.of(DataTypes.SLEEP, AccessType.READ));
        return set;
    }

    /** { granted: boolean } — whether all read permissions are already allowed. */
    @PluginMethod
    public void status(PluginCall call) {
        executor.execute(() -> {
            try {
                Set<Permission> granted = store().getGrantedPermissionsAsync(permissions()).get();
                JSObject result = new JSObject();
                result.put("granted", granted != null && granted.containsAll(permissions()));
                call.resolve(result);
            } catch (Throwable t) {
                fail(call, t, false);
            }
        });
    }

    /** Shows Samsung Health's permission screen. Resolves { granted: boolean }. */
    @PluginMethod
    public void requestAccess(PluginCall call) {
        try {
            store().requestPermissionsAsync(permissions(), getActivity()).setCallback(
                Looper.getMainLooper(),
                granted -> {
                    JSObject result = new JSObject();
                    result.put("granted", granted != null && granted.containsAll(permissions()));
                    call.resolve(result);
                },
                error -> fail(call, error, true)
            );
        } catch (Throwable t) {
            fail(call, t, true);
        }
    }

    /**
     * Today's totals, the last 24h of heart-rate samples, 7-day step/calorie history and sleep.
     * Times are epoch milliseconds; distance is in metres.
     */
    @PluginMethod
    public void readSummary(PluginCall call) {
        executor.execute(() -> {
            try {
                LocalDateTime now = LocalDateTime.now();
                LocalDateTime todayStart = LocalDate.now().atStartOfDay();
                LocalDateTime weekStart = todayStart.minusDays(WEEK_DAYS - 1);
                LocalTimeFilter today = LocalTimeFilter.of(todayStart, now);
                LocalTimeFilter week = LocalTimeFilter.of(weekStart, now);
                LocalTimeGroup daily = LocalTimeGroup.of(LocalTimeGroupUnit.DAILY, 1);

                JSObject result = new JSObject();

                // Today
                result.put("steps", sumNumbers(aggregate(
                    DataType.StepsType.TOTAL.getRequestBuilder().setLocalTimeFilter(today).build())));
                result.put("calories", sumNumbers(aggregate(
                    DataType.ActivitySummaryType.TOTAL_CALORIES_BURNED.getRequestBuilder().setLocalTimeFilter(today).build())));
                result.put("distance", sumNumbers(aggregate(
                    DataType.ActivitySummaryType.TOTAL_DISTANCE.getRequestBuilder().setLocalTimeFilter(today).build())));
                long activeMinutes = 0;
                for (AggregatedData<Duration> d : aggregate(
                        DataType.ActivitySummaryType.TOTAL_ACTIVE_TIME.getRequestBuilder().setLocalTimeFilter(today).build())) {
                    if (d.getValue() != null) activeMinutes += d.getValue().toMinutes();
                }
                result.put("activeMinutes", activeMinutes);

                // Last 7 days, one value per day (oldest first)
                result.put("weeklySteps", byDay(aggregate(
                    DataType.StepsType.TOTAL.getRequestBuilder().setLocalTimeFilterWithGroup(week, daily).build()), weekStart));
                result.put("weeklyCalories", byDay(aggregate(
                    DataType.ActivitySummaryType.TOTAL_CALORIES_BURNED.getRequestBuilder().setLocalTimeFilterWithGroup(week, daily).build()), weekStart));

                // Heart rate: every sample from the last 24 hours
                JSArray heartRate = new JSArray();
                for (HealthDataPoint p : readAll(DataTypes.HEART_RATE.getReadDataRequestBuilder()
                        .setLocalTimeFilter(LocalTimeFilter.of(now.minusHours(24), now))
                        .setOrdering(Ordering.ASC))) {
                    List<HeartRate> series = p.getValue(DataType.HeartRateType.SERIES_DATA);
                    if (series != null && !series.isEmpty()) {
                        for (HeartRate s : series) addSample(heartRate, s.getStartTime().toEpochMilli(), s.getHeartRate());
                    } else {
                        Float bpm = p.getValue(DataType.HeartRateType.HEART_RATE);
                        if (bpm != null) addSample(heartRate, p.getStartTime().toEpochMilli(), bpm);
                    }
                }
                result.put("heartRate", heartRate);

                // Sleep: hours per night for the last week, keyed by the date you woke up
                Map<String, Double> nights = new TreeMap<>();
                for (HealthDataPoint p : readAll(DataTypes.SLEEP.getReadDataRequestBuilder()
                        .setLocalTimeFilter(LocalTimeFilter.of(weekStart.minusDays(1), now))
                        .setOrdering(Ordering.ASC))) {
                    Duration d = p.getValue(DataType.SleepType.DURATION);
                    if (d == null && p.getStartTime() != null && p.getEndTime() != null) {
                        d = Duration.between(p.getStartTime(), p.getEndTime());
                    }
                    if (d == null || p.getEndLocalDateTime() == null) continue;
                    String date = p.getEndLocalDateTime().toLocalDate().toString();
                    nights.merge(date, d.toMinutes() / 60.0, Double::sum);
                }
                JSArray sleep = new JSArray();
                for (Map.Entry<String, Double> e : nights.entrySet()) {
                    JSObject n = new JSObject();
                    n.put("date", e.getKey());
                    n.put("hours", Math.round(e.getValue() * 10) / 10.0);
                    sleep.put(n);
                }
                result.put("sleep", sleep);

                call.resolve(result);
            } catch (Throwable t) {
                fail(call, t, false);
            }
        });
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private <T> List<AggregatedData<T>> aggregate(AggregateRequest<T> request) throws Exception {
        DataResponse<AggregatedData<T>> response = store().aggregateDataAsync(request).get();
        return response == null ? new ArrayList<>() : response.getDataList();
    }

    /** Reads every page of a request (the SDK returns large ranges in pages). */
    private List<HealthDataPoint> readAll(ReadDataRequest.DualTimeBuilder<HealthDataPoint> builder) throws Exception {
        List<HealthDataPoint> all = new ArrayList<>();
        String token = null;
        for (int page = 0; page < MAX_PAGES; page++) {
            if (token != null) builder.setPageToken(token);
            DataResponse<HealthDataPoint> response = store().readDataAsync(builder.build()).get();
            if (response == null) break;
            all.addAll(response.getDataList());
            token = response.getPageToken();
            if (token == null || token.isEmpty()) break;
        }
        return all;
    }

    private static <T> double sumNumbers(List<AggregatedData<T>> list) {
        double total = 0;
        for (AggregatedData<T> d : list) {
            Object v = d.getValue();
            if (v instanceof Number) total += ((Number) v).doubleValue();
        }
        return total;
    }

    private static <T> JSArray byDay(List<AggregatedData<T>> list, LocalDateTime weekStart) {
        double[] days = new double[WEEK_DAYS];
        for (AggregatedData<T> d : list) {
            Object v = d.getValue();
            if (!(v instanceof Number) || d.getStartLocalDateTime() == null) continue;
            long i = ChronoUnit.DAYS.between(weekStart.toLocalDate(), d.getStartLocalDateTime().toLocalDate());
            if (i >= 0 && i < WEEK_DAYS) days[(int) i] += ((Number) v).doubleValue();
        }
        JSArray out = new JSArray();
        for (double v : days) out.put(Math.round(v));
        return out;
    }

    private static void addSample(JSArray arr, long t, float bpm) {
        if (bpm <= 0) return;
        JSObject s = new JSObject();
        s.put("t", t);
        s.put("bpm", Math.round(bpm));
        arr.put(s);
    }

    /**
     * Rejects with a readable message and the SDK error code. If Samsung Health can fix the problem
     * itself (e.g. it needs updating), shows its resolution screen when the user started the action.
     */
    private void fail(PluginCall call, Throwable t, boolean userInitiated) {
        Throwable e = t;
        while ((e instanceof ExecutionException || e.getClass() == RuntimeException.class) && e.getCause() != null) {
            e = e.getCause();
        }
        String code = "UNKNOWN";
        String message = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
        if (e instanceof HealthDataException) {
            HealthDataException h = (HealthDataException) e;
            if (h.getErrorCode() != null) code = String.valueOf(h.getErrorCode());
            if (h.getErrorMessage() != null) message = h.getErrorMessage();
            if (userInitiated && e instanceof ResolvablePlatformException
                    && ((ResolvablePlatformException) e).getHasResolution() && getActivity() != null) {
                ResolvablePlatformException r = (ResolvablePlatformException) e;
                getActivity().runOnUiThread(() -> r.resolve(getActivity()));
                code = "RESOLVABLE";
            }
        }
        call.reject(message, code);
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
        super.handleOnDestroy();
    }
}
