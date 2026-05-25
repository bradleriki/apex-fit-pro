import { useState, useEffect, useRef, useCallback } from "react";
import { Home, Dumbbell, Camera, Salad, Watch, BarChart2, Bot, Flame, Zap, ChevronRight, Plus, RotateCcw, X, Send, RefreshCw, Sparkles, CheckCircle2, Play, Pause, Trophy, Target, TrendingDown, Heart, Footprints, Timer, Layers, Wifi, WifiOff, ScanLine, Trash2, ChevronDown, ChevronUp, Shield, Cpu, Swords, Wind, Leaf, Settings, Activity, Moon, Sun, Brain, Smile, Frown, Meh, CloudRain, Stars, BookOpen, BedDouble, AlertCircle } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE FIT CONFIG — paste your OAuth Client ID here
// ─────────────────────────────────────────────────────────────────────────────
const GFIT_CLIENT_ID = "219238177313-jsacshodqhaoni3r0ulf2poinnkucjnp.apps.googleusercontent.com";
const GFIT_SCOPES = [
  "https://www.googleapis.com/auth/fitness.activity.read",
  "https://www.googleapis.com/auth/fitness.heart_rate.read",
  "https://www.googleapis.com/auth/fitness.body.read",
  "https://www.googleapis.com/auth/fitness.location.read",
  "https://www.googleapis.com/auth/fitness.sleep.read",
].join(" ");
const FITNESS_API = "https://www.googleapis.com/fitness/v1/users/me";

function todayRange() {
  const now = Date.now();
  const s = new Date(); s.setHours(0,0,0,0);
  return { startMs: s.getTime(), endMs: now };
}
function weekRange() {
  return { startMs: Date.now() - 7*24*60*60*1000, endMs: Date.now() };
}
// Google's official merged data sources — aggregate from all writers (Samsung Health, etc.)
const MERGED_STEPS_SOURCE    = "derived:com.google.step_count.delta:com.google.android.gms:estimated_steps";
const MERGED_CALORIES_SOURCE = "derived:com.google.calories.expended:com.google.android.gms:merge_calories_expended";
const MERGED_HR_SOURCE       = "derived:com.google.heart_rate.bpm:com.google.android.gms:merge_heart_rate_bpm";

async function fetchFitData(token, type, startMs, endMs, bucket, sourceId) {
  const aggBy = sourceId ? { dataSourceId: sourceId } : { dataTypeName: type };
  const body = { aggregateBy:[aggBy], startTimeMillis:String(startMs), endTimeMillis:String(endMs), ...(bucket?{bucketByTime:{durationMillis:String(bucket)}}:{}) };
  const r = await fetch(`${FITNESS_API}/dataset:aggregate`, { method:"POST", headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"}, body:JSON.stringify(body) });
  return r.json();
}

// Fetch raw HR samples (no aggregation) so we can compute resting / max / zones / current
async function fetchHrSamples(token, startMs, endMs) {
  const startNs = `${startMs}000000`;
  const endNs   = `${endMs}000000`;
  const url = `${FITNESS_API}/dataSources/${MERGED_HR_SOURCE}/datasets/${startNs}-${endNs}`;
  const r = await fetch(url, { headers:{ Authorization:`Bearer ${token}` } });
  if (!r.ok) return [];
  const d = await r.json();
  return (d?.point || [])
    .map(p => ({ t: Math.floor(parseInt(p.endTimeNanos)/1e6), bpm: p.value?.[0]?.fpVal||0 }))
    .filter(s => s.bpm > 0)
    .sort((a,b) => a.t - b.t);
}

// Derive resting (10th percentile), max, current (most recent), avg, and zone % from samples
function computeHrStats(samples) {
  if (!samples.length) return { current:0, resting:0, max:0, avg:0, zones:{peak:0,cardio:0,aerobic:0,fatburn:0,rest:0} };
  const bpms = samples.map(s=>s.bpm);
  const sorted = [...bpms].sort((a,b)=>a-b);
  const resting = Math.round(sorted[Math.floor(sorted.length*0.1)] || sorted[0]);
  const max     = Math.round(sorted[sorted.length-1]);
  const avg     = Math.round(bpms.reduce((a,b)=>a+b,0) / bpms.length);
  const current = Math.round(samples[samples.length-1].bpm);
  const total = bpms.length;
  const count = (lo, hi) => bpms.filter(b => b >= lo && b < hi).length;
  const zones = {
    peak:    Math.round(count(150, 999) / total * 100),
    cardio:  Math.round(count(120, 150) / total * 100),
    aerobic: Math.round(count(90, 120)  / total * 100),
    fatburn: Math.round(count(60, 90)   / total * 100),
    rest:    Math.round(count(0, 60)    / total * 100),
  };
  return { current, resting, max, avg, zones };
}
const extractInt   = d => d?.bucket?.flatMap(b=>b.dataset?.flatMap(ds=>ds.point?.map(p=>p.value?.[0]?.intVal||0)||[])||[]).reduce((a,b)=>a+b,0)||0;
const extractFloat = d => d?.bucket?.flatMap(b=>b.dataset?.flatMap(ds=>ds.point?.map(p=>p.value?.[0]?.fpVal||0)||[])||[]).reduce((a,b)=>a+b,0)||0;
const extractHR    = d => { const v=(d?.bucket?.flatMap(b=>b.dataset?.flatMap(ds=>ds.point?.map(p=>p.value?.[0]?.fpVal||0)||[])||[])||[]).filter(x=>x>0); return v.length?Math.round(v.reduce((a,b)=>a+b,0)/v.length):0; };
const extractDaily = d => d?.bucket?.map(b=>{ const p=b.dataset?.flatMap(ds=>ds.point?.map(p=>p.value?.[0]?.intVal||p.value?.[0]?.fpVal||0)||[])||[]; return Math.round(p.reduce((a,v)=>a+v,0)); })||[];

// Sleep data comes from the sessions endpoint, not aggregate
async function fetchSleepSessions(token, startMs, endMs) {
  const r = await fetch(
    `https://www.googleapis.com/fitness/v1/users/me/sessions?startTime=${new Date(startMs).toISOString()}&endTime=${new Date(endMs).toISOString()}&activityType=72`,
    { headers:{ Authorization:`Bearer ${token}` } }
  );
  const d = await r.json();
  // activityType 72 = sleep. Sum durations and build nightly breakdown
  const sessions = d?.session || [];
  const nights = {};
  sessions.forEach(s => {
    const night = new Date(parseInt(s.startTimeMillis)).toISOString().slice(0,10);
    const hrs   = (parseInt(s.endTimeMillis) - parseInt(s.startTimeMillis)) / 3600000;
    nights[night] = (nights[night]||0) + hrs;
  });
  const entries = Object.entries(nights).map(([date,hours])=>({ date, hours:Math.round(hours*10)/10 })).sort((a,b)=>b.date.localeCompare(a.date));
  const lastNight = entries[0] || null;
  return { entries, lastNight };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS & DATA
// ─────────────────────────────────────────────────────────────────────────────
const WORKOUTS = [
  { id:1, name:"Morning Burn",      type:"HIIT",        duration:25, calories:320, difficulty:"Moderate", exercises:["Burpees","Jump Squats","Mountain Climbers","High Knees","Push-ups"],              muscles:["Full Body"] },
  { id:2, name:"Upper Body Power",  type:"Strength",    duration:40, calories:280, difficulty:"Hard",     exercises:["Push-ups","Dips","Pike Push-ups","Plank Shoulder Taps","Diamond Push-ups"],       muscles:["Chest","Shoulders","Triceps"] },
  { id:3, name:"Core Crusher",      type:"Core",        duration:20, calories:180, difficulty:"Moderate", exercises:["Plank","Crunches","Leg Raises","Russian Twists","Bicycle Crunches"],              muscles:["Core","Abs"] },
  { id:4, name:"Leg Day Inferno",   type:"Strength",    duration:35, calories:310, difficulty:"Hard",     exercises:["Squats","Lunges","Glute Bridges","Wall Sit","Jump Squats"],                      muscles:["Quads","Glutes","Hamstrings"] },
  { id:5, name:"Yoga Flow",         type:"Flexibility", duration:30, calories:140, difficulty:"Easy",     exercises:["Sun Salutation","Warrior I","Downward Dog","Child's Pose","Pigeon Pose"],        muscles:["Full Body"] },
  { id:6, name:"Cardio Blast",      type:"Cardio",      duration:30, calories:350, difficulty:"Hard",     exercises:["Sprint Intervals","Jump Rope","Box Jumps","Jumping Jacks","Skaters"],            muscles:["Legs","Cardio"] },
];

// ─────────────────────────────────────────────────────────────────────────────
// PROGRAM WORKOUT LIBRARY — exercises with sets/reps/weight for progression
// ─────────────────────────────────────────────────────────────────────────────
const PROGRAM_WORKOUTS = {
  // === FULL BODY (beginner) ===
  "fb-a": { id:"fb-a", name:"Full Body A", type:"Strength", duration:45, calories:320, difficulty:"Moderate", muscles:["Full Body"],
    exercises:[
      { name:"Goblet Squat",    sets:3, reps:"10-12", restSec:60, weighted:true },
      { name:"Push-ups",        sets:3, reps:"8-12",  restSec:45, weighted:false },
      { name:"Dumbbell Row",    sets:3, reps:"10-12", restSec:60, weighted:true },
      { name:"Glute Bridges",   sets:3, reps:"12-15", restSec:45, weighted:false },
      { name:"Plank",           sets:3, reps:"30-45s",restSec:30, weighted:false },
    ]},
  "fb-b": { id:"fb-b", name:"Full Body B", type:"Strength", duration:45, calories:330, difficulty:"Moderate", muscles:["Full Body"],
    exercises:[
      { name:"Romanian Deadlift", sets:3, reps:"8-10",  restSec:75, weighted:true },
      { name:"Dumbbell Press",    sets:3, reps:"10-12", restSec:60, weighted:true },
      { name:"Lat Pulldown",      sets:3, reps:"10-12", restSec:60, weighted:true },
      { name:"Walking Lunges",    sets:3, reps:"10/leg",restSec:60, weighted:true },
      { name:"Russian Twists",    sets:3, reps:"20",    restSec:30, weighted:false },
    ]},
  "fb-c": { id:"fb-c", name:"Full Body C", type:"Strength", duration:45, calories:325, difficulty:"Moderate", muscles:["Full Body"],
    exercises:[
      { name:"Front Squat",     sets:3, reps:"8-10",  restSec:75, weighted:true },
      { name:"Incline Push-ups",sets:3, reps:"10-12", restSec:45, weighted:false },
      { name:"Inverted Row",    sets:3, reps:"8-10",  restSec:60, weighted:false },
      { name:"Step-ups",        sets:3, reps:"10/leg",restSec:60, weighted:true },
      { name:"Dead Bug",        sets:3, reps:"10/side",restSec:30, weighted:false },
    ]},

  // === UPPER / LOWER (intermediate) ===
  "upper-a": { id:"upper-a", name:"Upper Body A", type:"Strength", duration:50, calories:340, difficulty:"Hard", muscles:["Chest","Back","Shoulders"],
    exercises:[
      { name:"Bench Press",     sets:4, reps:"6-8",   restSec:90, weighted:true },
      { name:"Pull-ups",        sets:4, reps:"6-10",  restSec:90, weighted:false },
      { name:"Overhead Press",  sets:3, reps:"8-10",  restSec:75, weighted:true },
      { name:"Barbell Row",     sets:3, reps:"8-10",  restSec:75, weighted:true },
      { name:"Bicep Curl",      sets:3, reps:"10-12", restSec:45, weighted:true },
      { name:"Tricep Pushdown", sets:3, reps:"10-12", restSec:45, weighted:true },
    ]},
  "lower-a": { id:"lower-a", name:"Lower Body A", type:"Strength", duration:55, calories:380, difficulty:"Hard", muscles:["Quads","Glutes","Hamstrings"],
    exercises:[
      { name:"Back Squat",       sets:4, reps:"6-8",  restSec:120,weighted:true },
      { name:"Romanian Deadlift",sets:4, reps:"8-10", restSec:90, weighted:true },
      { name:"Leg Press",        sets:3, reps:"10-12",restSec:75, weighted:true },
      { name:"Leg Curl",         sets:3, reps:"10-12",restSec:60, weighted:true },
      { name:"Calf Raises",      sets:4, reps:"12-15",restSec:45, weighted:true },
    ]},
  "upper-b": { id:"upper-b", name:"Upper Body B", type:"Strength", duration:50, calories:340, difficulty:"Hard", muscles:["Chest","Back","Shoulders"],
    exercises:[
      { name:"Incline Press",   sets:4, reps:"8-10",  restSec:75, weighted:true },
      { name:"Lat Pulldown",    sets:4, reps:"8-10",  restSec:75, weighted:true },
      { name:"Dumbbell Press",  sets:3, reps:"10-12", restSec:60, weighted:true },
      { name:"Seated Row",      sets:3, reps:"10-12", restSec:60, weighted:true },
      { name:"Lateral Raise",   sets:3, reps:"12-15", restSec:45, weighted:true },
      { name:"Face Pull",       sets:3, reps:"12-15", restSec:45, weighted:true },
    ]},
  "lower-b": { id:"lower-b", name:"Lower Body B", type:"Strength", duration:55, calories:370, difficulty:"Hard", muscles:["Quads","Glutes","Hamstrings"],
    exercises:[
      { name:"Deadlift",         sets:4, reps:"5-6",  restSec:120,weighted:true },
      { name:"Front Squat",      sets:3, reps:"8-10", restSec:90, weighted:true },
      { name:"Bulgarian Split",  sets:3, reps:"8/leg",restSec:75, weighted:true },
      { name:"Hip Thrust",       sets:3, reps:"10-12",restSec:60, weighted:true },
      { name:"Hanging Leg Raise",sets:3, reps:"10-15",restSec:45, weighted:false },
    ]},

  // === PUSH / PULL / LEGS (advanced) ===
  "push-a": { id:"push-a", name:"Push A — Chest Focus", type:"Strength", duration:55, calories:360, difficulty:"Hard", muscles:["Chest","Shoulders","Triceps"],
    exercises:[
      { name:"Bench Press",      sets:4, reps:"6-8",  restSec:90, weighted:true },
      { name:"Incline Press",    sets:3, reps:"8-10", restSec:75, weighted:true },
      { name:"Overhead Press",   sets:3, reps:"8-10", restSec:75, weighted:true },
      { name:"Cable Fly",        sets:3, reps:"12-15",restSec:60, weighted:true },
      { name:"Tricep Pushdown",  sets:3, reps:"10-12",restSec:45, weighted:true },
      { name:"Dips",             sets:3, reps:"8-12", restSec:60, weighted:false },
    ]},
  "pull-a": { id:"pull-a", name:"Pull A — Back Focus", type:"Strength", duration:55, calories:350, difficulty:"Hard", muscles:["Back","Biceps","Rear Delts"],
    exercises:[
      { name:"Deadlift",         sets:4, reps:"5-6",  restSec:120,weighted:true },
      { name:"Pull-ups",         sets:4, reps:"6-10", restSec:90, weighted:false },
      { name:"Barbell Row",      sets:3, reps:"8-10", restSec:75, weighted:true },
      { name:"Face Pull",        sets:3, reps:"12-15",restSec:45, weighted:true },
      { name:"Barbell Curl",     sets:3, reps:"8-10", restSec:60, weighted:true },
      { name:"Hammer Curl",      sets:3, reps:"10-12",restSec:45, weighted:true },
    ]},
  "legs-a": { id:"legs-a", name:"Legs A — Quad Focus", type:"Strength", duration:60, calories:420, difficulty:"Hard", muscles:["Quads","Glutes","Calves"],
    exercises:[
      { name:"Back Squat",       sets:4, reps:"6-8",  restSec:120,weighted:true },
      { name:"Leg Press",        sets:3, reps:"10-12",restSec:90, weighted:true },
      { name:"Walking Lunges",   sets:3, reps:"10/leg",restSec:75,weighted:true },
      { name:"Leg Extension",    sets:3, reps:"12-15",restSec:60, weighted:true },
      { name:"Calf Raises",      sets:4, reps:"12-15",restSec:45, weighted:true },
    ]},
  "push-b": { id:"push-b", name:"Push B — Shoulder Focus", type:"Strength", duration:50, calories:330, difficulty:"Hard", muscles:["Shoulders","Chest","Triceps"],
    exercises:[
      { name:"Overhead Press",   sets:4, reps:"6-8",  restSec:90, weighted:true },
      { name:"Dumbbell Press",   sets:3, reps:"8-10", restSec:75, weighted:true },
      { name:"Lateral Raise",    sets:4, reps:"12-15",restSec:45, weighted:true },
      { name:"Front Raise",      sets:3, reps:"12-15",restSec:45, weighted:true },
      { name:"Skull Crushers",   sets:3, reps:"10-12",restSec:60, weighted:true },
      { name:"Diamond Push-ups", sets:3, reps:"8-12", restSec:45, weighted:false },
    ]},
  "pull-b": { id:"pull-b", name:"Pull B — Width Focus", type:"Strength", duration:50, calories:330, difficulty:"Hard", muscles:["Back","Biceps"],
    exercises:[
      { name:"Lat Pulldown",     sets:4, reps:"8-10", restSec:75, weighted:true },
      { name:"Seated Row",       sets:3, reps:"10-12",restSec:75, weighted:true },
      { name:"Dumbbell Row",     sets:3, reps:"10-12",restSec:60, weighted:true },
      { name:"Shrugs",           sets:3, reps:"12-15",restSec:45, weighted:true },
      { name:"Preacher Curl",    sets:3, reps:"10-12",restSec:45, weighted:true },
    ]},
  "legs-b": { id:"legs-b", name:"Legs B — Posterior Focus", type:"Strength", duration:60, calories:400, difficulty:"Hard", muscles:["Hamstrings","Glutes","Calves"],
    exercises:[
      { name:"Romanian Deadlift",sets:4, reps:"8-10", restSec:90, weighted:true },
      { name:"Hip Thrust",       sets:4, reps:"10-12",restSec:75, weighted:true },
      { name:"Bulgarian Split",  sets:3, reps:"8/leg",restSec:75, weighted:true },
      { name:"Leg Curl",         sets:3, reps:"10-12",restSec:60, weighted:true },
      { name:"Standing Calf",    sets:4, reps:"12-15",restSec:45, weighted:true },
    ]},

  // === HIIT & CARDIO ===
  "hiit-full":   { id:"hiit-full",   name:"HIIT Full Body",      type:"HIIT",   duration:30, calories:380, difficulty:"Hard", muscles:["Full Body"],
    exercises:[
      { name:"Burpees",          sets:4, reps:"40s on/20s off", restSec:0, weighted:false },
      { name:"Mountain Climbers",sets:4, reps:"40s on/20s off", restSec:0, weighted:false },
      { name:"Jump Squats",      sets:4, reps:"40s on/20s off", restSec:0, weighted:false },
      { name:"High Knees",       sets:4, reps:"40s on/20s off", restSec:0, weighted:false },
      { name:"Push-up to T",     sets:4, reps:"40s on/20s off", restSec:0, weighted:false },
    ]},
  "hiit-circuit":{ id:"hiit-circuit",name:"Strength Circuit",    type:"Circuit",duration:35, calories:340, difficulty:"Hard", muscles:["Full Body"],
    exercises:[
      { name:"Goblet Squat",     sets:4, reps:"15",   restSec:30, weighted:true },
      { name:"Push-ups",         sets:4, reps:"12",   restSec:30, weighted:false },
      { name:"Kettlebell Swing", sets:4, reps:"15",   restSec:30, weighted:true },
      { name:"Renegade Row",     sets:4, reps:"10",   restSec:30, weighted:true },
      { name:"Plank",            sets:4, reps:"45s",  restSec:30, weighted:false },
    ]},
  "cardio-steady":{ id:"cardio-steady",name:"Steady Cardio",      type:"Cardio", duration:40, calories:360, difficulty:"Moderate", muscles:["Cardio"],
    exercises:[
      { name:"Treadmill / Bike / Row", sets:1, reps:"40min @ Zone 2", restSec:0, weighted:false },
    ]},
  "core-finisher":{ id:"core-finisher",name:"Core Finisher",      type:"Core",   duration:20, calories:160, difficulty:"Moderate", muscles:["Core","Abs"],
    exercises:[
      { name:"Plank",            sets:3, reps:"45s",  restSec:30, weighted:false },
      { name:"Russian Twists",   sets:3, reps:"20",   restSec:30, weighted:false },
      { name:"Leg Raises",       sets:3, reps:"12",   restSec:30, weighted:false },
      { name:"Dead Bug",         sets:3, reps:"10/side",restSec:30,weighted:false },
      { name:"Mountain Climbers",sets:3, reps:"30s",  restSec:30, weighted:false },
    ]},

  // === ENDURANCE ===
  "endur-tempo":{ id:"endur-tempo",name:"Tempo Run",          type:"Cardio", duration:35, calories:380, difficulty:"Hard", muscles:["Cardio","Legs"],
    exercises:[ { name:"Tempo Run", sets:1, reps:"5min easy + 20min tempo + 5min cooldown", restSec:0, weighted:false } ]},
  "endur-long": { id:"endur-long", name:"Long Steady State",  type:"Cardio", duration:60, calories:540, difficulty:"Moderate", muscles:["Cardio","Legs"],
    exercises:[ { name:"Long Run/Bike", sets:1, reps:"60min @ Zone 2", restSec:0, weighted:false } ]},
  "endur-intervals":{ id:"endur-intervals",name:"Interval Training",type:"Cardio", duration:30, calories:340, difficulty:"Hard", muscles:["Cardio","Legs"],
    exercises:[ { name:"Intervals", sets:8, reps:"1min hard / 1min easy", restSec:0, weighted:false } ]},
  "endur-strength":{ id:"endur-strength",name:"Runner's Strength",type:"Strength", duration:40, calories:280, difficulty:"Moderate", muscles:["Legs","Core"],
    exercises:[
      { name:"Single-Leg Squat", sets:3, reps:"8/leg", restSec:60, weighted:false },
      { name:"Step-ups",         sets:3, reps:"10/leg",restSec:60, weighted:true },
      { name:"Glute Bridges",    sets:3, reps:"12-15", restSec:45, weighted:false },
      { name:"Plank",            sets:3, reps:"45s",   restSec:30, weighted:false },
      { name:"Side Plank",       sets:3, reps:"30s/side",restSec:30,weighted:false },
    ]},

  // === FLEXIBILITY / MOBILITY ===
  "mob-flow":  { id:"mob-flow",  name:"Full Body Flow",   type:"Flexibility", duration:40, calories:180, difficulty:"Easy", muscles:["Full Body"],
    exercises:[
      { name:"Sun Salutation",   sets:1, reps:"5 rounds",restSec:0, weighted:false },
      { name:"Warrior Sequence", sets:1, reps:"both sides",restSec:0,weighted:false },
      { name:"Pigeon Pose",      sets:1, reps:"90s/side",restSec:0,weighted:false },
      { name:"Lizard Pose",      sets:1, reps:"60s/side",restSec:0,weighted:false },
      { name:"Savasana",         sets:1, reps:"5min",   restSec:0, weighted:false },
    ]},
  "mob-hip":   { id:"mob-hip",   name:"Hip & Lower Body", type:"Flexibility", duration:30, calories:140, difficulty:"Easy", muscles:["Hips","Legs"],
    exercises:[
      { name:"Hip 90/90",        sets:1, reps:"10/side", restSec:0, weighted:false },
      { name:"Couch Stretch",    sets:1, reps:"60s/side",restSec:0, weighted:false },
      { name:"Cossack Squat",    sets:1, reps:"10/side", restSec:0, weighted:false },
      { name:"Frog Stretch",     sets:1, reps:"90s",     restSec:0, weighted:false },
      { name:"Pigeon Pose",      sets:1, reps:"90s/side",restSec:0, weighted:false },
    ]},
  "mob-thoracic":{id:"mob-thoracic",name:"Thoracic & Shoulders",type:"Flexibility",duration:25,calories:120,difficulty:"Easy",muscles:["Back","Shoulders"],
    exercises:[
      { name:"Cat-Cow",          sets:1, reps:"10 reps",  restSec:0, weighted:false },
      { name:"Thread the Needle",sets:1, reps:"8/side",   restSec:0, weighted:false },
      { name:"Cobra Pose",       sets:1, reps:"5x 15s",   restSec:0, weighted:false },
      { name:"Doorway Stretch",  sets:1, reps:"60s/side", restSec:0, weighted:false },
      { name:"Child's Pose",     sets:1, reps:"2min",     restSec:0, weighted:false },
    ]},
  "mob-strength":{id:"mob-strength",name:"Strength + Mobility",type:"Strength",duration:35,calories:200,difficulty:"Moderate",muscles:["Full Body"],
    exercises:[
      { name:"Turkish Get-up",   sets:3, reps:"5/side",   restSec:60, weighted:true },
      { name:"Goblet Squat",     sets:3, reps:"10-12",    restSec:45, weighted:true },
      { name:"Push-up to T",     sets:3, reps:"8/side",   restSec:45, weighted:false },
      { name:"Bird Dog",         sets:3, reps:"10/side",  restSec:30, weighted:false },
      { name:"Hollow Hold",      sets:3, reps:"30s",      restSec:30, weighted:false },
    ]},
};

// ─────────────────────────────────────────────────────────────────────────────
// CURATED PROGRAMS — 7-day schedules
// schedule[0]=Mon ... schedule[6]=Sun. null = rest. restActivity = light suggestion.
// ─────────────────────────────────────────────────────────────────────────────
const PROGRAMS = [
  { id:"fb-3day", name:"Full Body Foundation", emoji:"💪",
    description:"3-day full body. The classic beginner builder.",
    goal:"flex", level:"beginner", daysPerWeek:3,
    schedule:["fb-a", null, "fb-b", null, "fb-c", null, null],
    restActivity:"20-30min walk, light stretching, or yoga flow." },

  { id:"ul-4day", name:"Upper / Lower Split", emoji:"⚡",
    description:"4-day split for balanced strength and muscle.",
    goal:"muscle", level:"intermediate", daysPerWeek:4,
    schedule:["upper-a", "lower-a", null, "upper-b", "lower-b", null, null],
    restActivity:"30-45min walk, mobility work, or recovery yoga." },

  { id:"ppl-5day", name:"Push Pull Legs", emoji:"🔥",
    description:"5-day muscle building split. The gold standard.",
    goal:"muscle", level:"intermediate", daysPerWeek:5,
    schedule:["push-a", "pull-a", "legs-a", null, "push-b", "pull-b", null],
    restActivity:"Active recovery: 30min walk, stretching, or light cycling." },

  { id:"hiit-lose", name:"HIIT & Burn", emoji:"🔥",
    description:"5-day fat-loss focus. High intensity + circuits.",
    goal:"lose", level:"intermediate", daysPerWeek:5,
    schedule:["hiit-full", "hiit-circuit", "cardio-steady", null, "hiit-full", "core-finisher", null],
    restActivity:"45-60min walk, light yoga, or foam rolling." },

  { id:"endurance", name:"Endurance Builder", emoji:"🏃",
    description:"Cardio-focused with supportive strength work.",
    goal:"endurance", level:"intermediate", daysPerWeek:5,
    schedule:["endur-tempo", "endur-strength", null, "endur-intervals", null, "endur-long", null],
    restActivity:"30min easy walk, dynamic stretching, or mobility flow." },

  { id:"flex-focus", name:"Mobility & Flow", emoji:"🧘",
    description:"Flexibility, mobility, and gentle strength.",
    goal:"flex", level:"beginner", daysPerWeek:5,
    schedule:["mob-flow", "mob-strength", null, "mob-hip", "mob-thoracic", null, "mob-flow"],
    restActivity:"Light walk, deep breathing, or a meditation session." },
];

// ─────────────────────────────────────────────────────────────────────────────
// PROGRAM HELPERS
// ─────────────────────────────────────────────────────────────────────────────
// Recommend a program based on user's onboarding profile
function recommendProgram(profile) {
  if (!profile) return PROGRAMS[0];
  const goal = profile.goal;
  const level = profile.level;
  // Match goal first
  let candidates = PROGRAMS.filter(p=>p.goal===goal);
  if (!candidates.length) candidates = PROGRAMS;
  // Prefer matching level
  const levelMatch = candidates.find(p=>p.level===level);
  return levelMatch || candidates[0];
}

// Get the program day index (0=Mon...6=Sun) for a given date
function programDayForDate(date) {
  const dow = date.getDay(); // 0=Sun, 1=Mon, ... 6=Sat
  return dow === 0 ? 6 : dow - 1; // shift so 0=Mon, 6=Sun
}

// Suggested next-session progression for an exercise based on its history
function suggestProgression(history, exercise) {
  if (!history || !history.length) return null;
  const last = history[history.length-1];
  if (exercise.weighted && last.weight) {
    // Standard linear progression: +2.5kg for lower body, +1.25kg for upper, or +1 rep
    const isLower = /squat|deadlift|leg|hip|lunge|step/i.test(exercise.name);
    const bump = isLower ? 2.5 : 1.25;
    return { type:"weight", suggested:`${last.weight + bump}kg × ${last.reps}`, last:`${last.weight}kg × ${last.reps}` };
  }
  // Bodyweight: suggest +1 rep
  if (last.reps) {
    return { type:"reps", suggested:`${Math.round(last.reps) + 1} reps`, last:`${last.reps} reps` };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 🎮 GAME SYSTEM — Classes, XP, Levels, Stats
// ─────────────────────────────────────────────────────────────────────────────
const CLASSES = [
  { id:"berserker", name:"Berserker", emoji:"⚔️", icon:"⚔️",
    tagline:"Forged in iron",
    description:"Heavy lifts. Brutal strength. The path of the powerhouse.",
    color:"#ff3d2e",
    statBias:{ STR:1.5, AGI:0.8, STA:1.0, WIS:0.7, VIT:1.0 },
    suitsGoal:"muscle" },
  { id:"ranger", name:"Ranger", emoji:"🏹", icon:"🏹",
    tagline:"Swift as the wind",
    description:"Long runs. Endless stamina. Master of distance.",
    color:"#4ade80",
    statBias:{ STR:0.8, AGI:1.4, STA:1.5, WIS:0.9, VIT:1.0 },
    suitsGoal:"endurance" },
  { id:"monk", name:"Monk", emoji:"🧘", icon:"🧘",
    tagline:"Calm in the storm",
    description:"Flexibility, mindfulness, breath. The balanced path.",
    color:"#a78bfa",
    statBias:{ STR:0.8, AGI:1.1, STA:1.0, WIS:1.6, VIT:1.1 },
    suitsGoal:"flex" },
  { id:"guardian", name:"Guardian", emoji:"🛡️", icon:"🛡️",
    tagline:"Steady and true",
    description:"All-round athlete. No weakness, no specialty.",
    color:"#00e5ff",
    statBias:{ STR:1.1, AGI:1.1, STA:1.1, WIS:1.1, VIT:1.1 },
    suitsGoal:null },
  { id:"pyromancer", name:"Pyromancer", emoji:"🔥", icon:"🔥",
    tagline:"Burn it all",
    description:"HIIT. Fat loss. Explosive, fast, fierce.",
    color:"#ffd700",
    statBias:{ STR:1.0, AGI:1.5, STA:1.2, WIS:0.8, VIT:1.2 },
    suitsGoal:"lose" },
];

// Tier thresholds (level → tier)
const TIERS = [
  { name:"Novice",    min:1,  max:10, color:"#94a3b8" },
  { name:"Adept",     min:11, max:25, color:"#4ade80" },
  { name:"Expert",    min:26, max:50, color:"#a78bfa" },
  { name:"Champion",  min:51, max:75, color:"#ffd700" },
  { name:"Legend",    min:76, max:99, color:"#ff3d2e" },
];

// XP needed to reach level N (cumulative). Quadratic curve so progression feels meaningful.
function xpForLevel(level) {
  if (level <= 1) return 0;
  return Math.round(100 * Math.pow(level - 1, 1.6));
}

// Get current level from total XP
function levelFromXp(totalXp) {
  let lvl = 1;
  while (lvl < 99 && xpForLevel(lvl + 1) <= totalXp) lvl++;
  return lvl;
}

// Get tier info for a level
function tierForLevel(level) {
  return TIERS.find(t => level >= t.min && level <= t.max) || TIERS[0];
}

// XP progress within current level: { current, needed, pct }
function xpProgress(totalXp) {
  const lvl = levelFromXp(totalXp);
  const thisLevelStart = xpForLevel(lvl);
  const nextLevelStart = lvl >= 99 ? thisLevelStart : xpForLevel(lvl + 1);
  const current = totalXp - thisLevelStart;
  const needed = nextLevelStart - thisLevelStart;
  return { current, needed, pct: needed > 0 ? Math.min(100, (current/needed)*100) : 100 };
}

// XP reward constants for each action
const XP_REWARDS = {
  WORKOUT_COMPLETE:    100,
  WORKOUT_SET_LOGGED:  5,
  MEAL_LOGGED:         15,
  PROTEIN_GOAL_HIT:    50,
  CALORIE_GOAL_HIT:    50,
  SLEEP_7H:            40,
  MEDITATION:          30,
  BREATHWORK:          20,
  STEPS_8K:            30,
  STEPS_12K:           60,
  MOOD_LOG:            10,
  STRESS_LOG:          10,
  STREAK_BONUS_DAY:    20, // bonus per streak day, capped
};

// Calculate stat gain from a single workout
function workoutStatGain(workout, classObj) {
  const bias = classObj?.statBias || { STR:1, AGI:1, STA:1, WIS:1, VIT:1 };
  const isStrength = /Strength|Power/i.test(workout.type||"");
  const isHIIT = /HIIT|Circuit/i.test(workout.type||"");
  const isCardio = /Cardio/i.test(workout.type||"");
  const isFlex = /Flex|Yoga|Mobility/i.test(workout.type||"");
  const isCore = /Core/i.test(workout.type||"");
  const duration = workout.duration || 30;

  const gains = { STR:0, AGI:0, STA:0, WIS:0, VIT:0 };
  if (isStrength) { gains.STR += 3; gains.STA += 1; }
  if (isHIIT)     { gains.AGI += 2; gains.STA += 2; gains.VIT += 1; }
  if (isCardio)   { gains.STA += 3; gains.AGI += 1; }
  if (isFlex)     { gains.WIS += 2; gains.AGI += 1; }
  if (isCore)     { gains.STR += 1; gains.AGI += 1; gains.STA += 1; }
  if (duration >= 45) gains.STA += 1;

  // Apply class bias (multiplied, then floored)
  Object.keys(gains).forEach(k => {
    gains[k] = Math.max(0, Math.floor(gains[k] * (bias[k]||1)));
  });
  return gains;
}

// Aggregate today's XP from various sources (helper for the dashboard preview)
function dayXpPreview(ctx) {
  // ctx: { workoutsCompletedToday, mealsLogged, totalPro, proteinTarget, totalCal, calTarget, gfit, meditationToday, breathToday, moodLoggedToday }
  let xp = 0;
  xp += (ctx.workoutsCompletedToday||0) * XP_REWARDS.WORKOUT_COMPLETE;
  xp += (ctx.mealsLogged||0) * XP_REWARDS.MEAL_LOGGED;
  if (ctx.totalPro >= (ctx.proteinTarget||0) * 0.9) xp += XP_REWARDS.PROTEIN_GOAL_HIT;
  if (ctx.totalCal >= (ctx.calTarget||0) * 0.9 && ctx.totalCal <= (ctx.calTarget||0) * 1.1) xp += XP_REWARDS.CALORIE_GOAL_HIT;
  if (ctx.gfit?.steps >= 12000) xp += XP_REWARDS.STEPS_12K;
  else if (ctx.gfit?.steps >= 8000) xp += XP_REWARDS.STEPS_8K;
  if (ctx.meditationToday) xp += XP_REWARDS.MEDITATION;
  if (ctx.breathToday) xp += XP_REWARDS.BREATHWORK;
  if (ctx.moodLoggedToday) xp += XP_REWARDS.MOOD_LOG;
  return xp;
}

// ─────────────────────────────────────────────────────────────────────────────
// MEALS
// ─────────────────────────────────────────────────────────────────────────────

const PRESET_MEALS = [
  // ── BREAKFAST (6 options) ──────────────────────────────────────────
  { id:1,  name:"Power Oatmeal",          time:"Breakfast", calories:380, protein:18, carbs:52, fat:9,  tags:["High Protein","Complex Carbs"], goalFit:["muscle","endurance","flex"], portion:"1 bowl (350g)",   portions:["½ bowl (175g)","1 bowl (350g)","1½ bowls (525g)"] },
  { id:2,  name:"Veggie Omelette",        time:"Breakfast", calories:340, protein:26, carbs:8,  fat:22, tags:["High Protein","Low Carb"],       goalFit:["muscle","lose","flex"],      portion:"3-egg omelette",  portions:["2 eggs","3 eggs","4 eggs"] },
  { id:3,  name:"Greek Yogurt Bowl",      time:"Breakfast", calories:290, protein:24, carbs:32, fat:6,  tags:["Probiotic","High Protein"],      goalFit:["lose","muscle","flex"],      portion:"1 bowl (300g)",   portions:["½ bowl (150g)","1 bowl (300g)","1½ bowls (450g)"] },
  { id:4,  name:"Avocado Toast & Eggs",   time:"Breakfast", calories:420, protein:20, carbs:34, fat:24, tags:["Healthy Fats","Balanced"],       goalFit:["muscle","flex","endurance"], portion:"2 slices",        portions:["1 slice","2 slices","3 slices"] },
  { id:5,  name:"Protein Pancakes",       time:"Breakfast", calories:410, protein:32, carbs:42, fat:11, tags:["High Protein","Filling"],        goalFit:["muscle","flex"],             portion:"3 pancakes",      portions:["2 pancakes","3 pancakes","4 pancakes"] },
  { id:6,  name:"Berry Smoothie Bowl",    time:"Breakfast", calories:320, protein:18, carbs:48, fat:6,  tags:["Antioxidants","Low Fat"],        goalFit:["lose","endurance","flex"],   portion:"1 bowl (400g)",   portions:["½ bowl (200g)","1 bowl (400g)","1½ bowls (600g)"] },

  // ── LUNCH (6 options) ──────────────────────────────────────────────
  { id:7,  name:"Grilled Chicken Bowl",   time:"Lunch", calories:520, protein:48, carbs:38, fat:14, tags:["High Protein","Low Fat"],          goalFit:["muscle","lose","flex"],      portion:"1 bowl (420g)",   portions:["½ bowl (210g)","1 bowl (420g)","1½ bowls (630g)"] },
  { id:8,  name:"Tuna Niçoise Salad",     time:"Lunch", calories:380, protein:32, carbs:22, fat:18, tags:["High Protein","Omega-3"],          goalFit:["lose","muscle","flex"],      portion:"1 salad (350g)",  portions:["½ salad (175g)","1 salad (350g)","1½ salads (525g)"] },
  { id:9,  name:"Beef & Quinoa Bowl",     time:"Lunch", calories:580, protein:42, carbs:54, fat:18, tags:["High Protein","Iron-rich"],        goalFit:["muscle","endurance"],        portion:"1 bowl (450g)",   portions:["½ bowl (225g)","1 bowl (450g)","1½ bowls (675g)"] },
  { id:10, name:"Turkey Wrap",            time:"Lunch", calories:440, protein:36, carbs:42, fat:14, tags:["High Protein","Balanced"],         goalFit:["muscle","flex","lose"],      portion:"1 wrap (300g)",   portions:["½ wrap (150g)","1 wrap (300g)","1½ wraps (450g)"] },
  { id:11, name:"Chickpea Buddha Bowl",   time:"Lunch", calories:460, protein:20, carbs:62, fat:14, tags:["Plant-based","Fiber"],             goalFit:["endurance","flex"],          portion:"1 bowl (450g)",   portions:["½ bowl (225g)","1 bowl (450g)","1½ bowls (675g)"] },
  { id:12, name:"Salmon Poke Bowl",       time:"Lunch", calories:540, protein:38, carbs:48, fat:18, tags:["Omega-3","Balanced"],              goalFit:["muscle","endurance","flex"], portion:"1 bowl (400g)",   portions:["½ bowl (200g)","1 bowl (400g)","1½ bowls (600g)"] },

  // ── DINNER (6 options) ─────────────────────────────────────────────
  { id:13, name:"Salmon & Greens",        time:"Dinner", calories:490, protein:42, carbs:22, fat:24, tags:["Omega-3","Keto-friendly"],         goalFit:["muscle","lose","flex"],      portion:"1 fillet (300g)", portions:["½ fillet (150g)","1 fillet (300g)","1½ fillets (450g)"] },
  { id:14, name:"Lean Steak & Sweet Potato", time:"Dinner", calories:610, protein:46, carbs:44, fat:24, tags:["High Protein","Iron-rich"],     goalFit:["muscle","endurance"],        portion:"200g steak",      portions:["150g","200g","250g"] },
  { id:15, name:"Chicken Stir Fry",       time:"Dinner", calories:480, protein:40, carbs:38, fat:16, tags:["High Protein","Veggies"],          goalFit:["muscle","lose","flex"],      portion:"1 plate (400g)",  portions:["½ plate (200g)","1 plate (400g)","1½ plates (600g)"] },
  { id:16, name:"Lentil Curry & Rice",    time:"Dinner", calories:510, protein:22, carbs:78, fat:10, tags:["Plant-based","Fiber"],             goalFit:["endurance","flex"],          portion:"1 plate (450g)",  portions:["½ plate (225g)","1 plate (450g)","1½ plates (675g)"] },
  { id:17, name:"Cod & Roast Veg",        time:"Dinner", calories:380, protein:36, carbs:24, fat:14, tags:["Low Cal","High Protein"],          goalFit:["lose","flex"],               portion:"1 fillet (250g)", portions:["½ fillet (125g)","1 fillet (250g)","1½ fillets (375g)"] },
  { id:18, name:"Turkey Meatballs & Pasta", time:"Dinner", calories:560, protein:42, carbs:62, fat:14, tags:["High Protein","Comfort"],         goalFit:["muscle","endurance","flex"], portion:"1 plate (400g)",  portions:["½ plate (200g)","1 plate (400g)","1½ plates (600g)"] },

  // ── SNACK (6 options) ──────────────────────────────────────────────
  { id:19, name:"Greek Yogurt Parfait",   time:"Snack", calories:210, protein:20, carbs:28, fat:4,  tags:["Probiotic","Low Cal"],            goalFit:["lose","muscle","flex"],      portion:"1 cup (240g)",    portions:["½ cup (120g)","1 cup (240g)","2 cups (480g)"] },
  { id:20, name:"Apple & Almond Butter",  time:"Snack", calories:240, protein:8,  carbs:28, fat:14, tags:["Healthy Fats","Filling"],         goalFit:["flex","endurance","lose"],   portion:"1 apple + 2 tbsp",portions:["½ apple + 1 tbsp","1 apple + 2 tbsp","1½ apples + 3 tbsp"] },
  { id:21, name:"Cottage Cheese & Berries", time:"Snack", calories:180, protein:22, carbs:16, fat:3, tags:["High Protein","Low Cal"],         goalFit:["lose","muscle","flex"],      portion:"1 cup (200g)",    portions:["½ cup (100g)","1 cup (200g)","1½ cups (300g)"] },
  { id:22, name:"Hummus & Veggies",       time:"Snack", calories:200, protein:8,  carbs:24, fat:10, tags:["Plant-based","Fiber"],            goalFit:["lose","flex","endurance"],   portion:"100g + veg",      portions:["50g + veg","100g + veg","150g + veg"] },
  { id:23, name:"Trail Mix",              time:"Snack", calories:280, protein:8,  carbs:24, fat:18, tags:["Healthy Fats","Energy"],          goalFit:["endurance","flex"],          portion:"45g",             portions:["30g","45g","60g"] },
  { id:24, name:"Boiled Eggs & Crackers", time:"Snack", calories:220, protein:18, carbs:14, fat:11, tags:["High Protein","Filling"],         goalFit:["muscle","lose","flex"],      portion:"2 eggs + 4",      portions:["1 egg + 2","2 eggs + 4","3 eggs + 6"] },

  // ── POST-WORKOUT (5 options) ───────────────────────────────────────
  { id:25, name:"Protein Smoothie",       time:"Post-Workout", calories:290, protein:32, carbs:35, fat:3,  tags:["Recovery","High Protein"],   goalFit:["muscle","endurance","flex"], portion:"1 shake (500ml)", portions:["½ shake (250ml)","1 shake (500ml)","2 shakes (1L)"] },
  { id:26, name:"Whey Shake & Banana",    time:"Post-Workout", calories:260, protein:28, carbs:34, fat:2,  tags:["Quick Recovery","Carbs"],    goalFit:["muscle","endurance"],        portion:"1 shake + 1",     portions:["½ shake","1 shake","1 shake + 2 bananas"] },
  { id:27, name:"Chocolate Milk",         time:"Post-Workout", calories:220, protein:14, carbs:32, fat:5,  tags:["Recovery","Classic"],        goalFit:["endurance","muscle"],        portion:"500ml",           portions:["250ml","500ml","750ml"] },
  { id:28, name:"Tuna & Rice Cakes",      time:"Post-Workout", calories:240, protein:26, carbs:24, fat:3,  tags:["Lean Protein","Low Fat"],    goalFit:["lose","muscle","flex"],      portion:"1 tin + 3",       portions:["½ tin + 2","1 tin + 3","1½ tins + 4"] },
  { id:29, name:"Cottage Cheese & Honey", time:"Post-Workout", calories:230, protein:24, carbs:22, fat:5,  tags:["High Protein","Slow Digest"], goalFit:["muscle","flex"],            portion:"1 cup (200g)",    portions:["½ cup (100g)","1 cup (200g)","1½ cups (300g)"] },
];

// ── Deterministic 7-day rotation ──────────────────────────────────────
// Picks one meal per slot for a given absolute day index, biased toward user's goal.
// Same dayIndex returns the same meal — so today is consistent across refreshes.
function getDayPlan(dayIndex, profile, swaps={}) {
  const goal = profile?.goal || "flex";
  const slots = ["Breakfast","Lunch","Dinner","Snack","Post-Workout"];
  const plan = {};
  slots.forEach((slot, si) => {
    // Check for manual swap first (user picked something specific for this day+slot)
    const swapKey = `${dayIndex}:${slot}`;
    if (swaps[swapKey]) { plan[slot] = swaps[swapKey]; return; }
    // Filter to meals matching goal, fall back to all if no matches
    const pool = PRESET_MEALS.filter(m=>m.time===slot && m.goalFit.includes(goal));
    const candidates = pool.length ? pool : PRESET_MEALS.filter(m=>m.time===slot);
    // Deterministic offset: rotate based on dayIndex + slot index so same day rotates all slots together
    const idx = (dayIndex + si*2) % candidates.length;
    plan[slot] = candidates[idx].id;
  });
  return plan;
}

// Absolute day index (days since epoch) — stable across timezones for "today"
function dayIndexFor(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor(d.getTime() / 86400000);
}

const EXERCISES_LIB = [
  "Push-ups","Pull-ups","Squats","Lunges","Burpees","Plank","Mountain Climbers",
  "Jump Squats","Dips","Crunches","Leg Raises","Russian Twists","Box Jumps",
  "High Knees","Jumping Jacks","Glute Bridges","Wall Sit","Pike Push-ups",
  "Bicycle Crunches","Sprint Intervals","Bear Crawls","Skaters","Superman",
];

const WEEK = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

const TC = { HIIT:"var(--brand)", Strength:"var(--brand2)", Core:"#ffd700", Cardio:"#00e5ff", Flexibility:"#a78bfa", Custom:"#4ade80" };

const ONBOARDING = [
  { key:"name",   q:"What should we call you?",          type:"text",   ph:"Your first name" },
  { key:"goal",   q:"What's your primary goal?",         type:"choice", opts:[{v:"lose",l:"🔥 Lose Weight"},{v:"muscle",l:"💪 Build Muscle"},{v:"endurance",l:"⚡ Endurance"},{v:"flex",l:"🧘 Flexibility"}] },
  { key:"level",  q:"What's your fitness level?",        type:"choice", opts:[{v:"beginner",l:"🌱 Beginner"},{v:"intermediate",l:"🏃 Intermediate"},{v:"advanced",l:"🔱 Advanced"}] },
  { key:"days",   q:"How many days per week?",           type:"choice", opts:[{v:"3",l:"3 days"},{v:"4",l:"4 days"},{v:"5",l:"5 days"},{v:"6",l:"6 days"}] },
  { key:"weight", q:"Current weight (kg)?",             type:"number", ph:"e.g. 84" },
  { key:"target", q:"Target weight (kg)?",              type:"number", ph:"e.g. 75" },
];

const FOOD_PROMPT = `You are an expert nutritionist. Analyze this food photo carefully.
Return ONLY valid JSON (no markdown, no backticks):
{"name":"Full meal name","confidence":92,"servingSize":"1 plate (~350g)","calories":520,"protein":38,"carbs":45,"fat":16,"fiber":6,"sugar":8,"sodium":720,"ingredients":["chicken","rice"],"healthScore":82,"mealType":"Lunch","dietTags":["High Protein"],"warnings":["High Sodium"],"tips":"Brief coaching tip under 40 words.","alternatives":["Swap X for Y"]}`;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const fmt  = s => `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
const pct  = (v,m) => Math.min(100, Math.round((v/Math.max(m,1))*100));
const b64  = f => new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result.split(",")[1]); r.onerror=()=>rej(); r.readAsDataURL(f); });

async function callClaude(messages, system="You are a helpful fitness coach. Be concise and motivational.") {
  const r = await fetch("/api/claude", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:1000, system, messages })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message || "API error");
  return d.content?.[0]?.text || "";
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED UI ATOMS
// ─────────────────────────────────────────────────────────────────────────────
function Card({ children, style={}, glow=false, onClick, ...rest }) {
  return (
    <div className={`glass${glow?" glass-hot":""}`} style={style} onClick={onClick} {...rest}>
      {children}
    </div>
  );
}

function PrimaryBtn({ children, onClick, disabled, style={} }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        background: disabled ? "var(--bg3)" : "var(--grad)",
        border: "none", color: disabled ? "var(--text3)" : "#fff",
        borderRadius: 12, padding: "13px 22px",
        fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 800, fontSize: 15,
        letterSpacing: 1, textTransform: "uppercase",
        cursor: disabled ? "default" : "pointer", width: "100%",
        transition: "all 0.2s", boxShadow: disabled ? "none" : "0 6px 24px rgba(255,61,46,0.3)",
        ...style
      }}
      onMouseEnter={e=>{ if(!disabled){ e.currentTarget.style.transform="translateY(-1px)"; e.currentTarget.style.boxShadow="0 8px 30px rgba(255,61,46,0.45)"; }}}
      onMouseLeave={e=>{ e.currentTarget.style.transform="none"; e.currentTarget.style.boxShadow=disabled?"none":"0 6px 24px rgba(255,61,46,0.3)"; }}>
      {children}
    </button>
  );
}

function GhostBtn({ children, onClick, style={} }) {
  return (
    <button onClick={onClick}
      style={{ background:"transparent", border:"1px solid var(--border2)", color:"var(--text2)", borderRadius:10, padding:"9px 18px", fontFamily:"'Syne',sans-serif", fontSize:13, fontWeight:600, cursor:"pointer", transition:"all 0.2s", ...style }}
      onMouseEnter={e=>{ e.currentTarget.style.borderColor="var(--brand)"; e.currentTarget.style.color="var(--brand)"; }}
      onMouseLeave={e=>{ e.currentTarget.style.borderColor="var(--border2)"; e.currentTarget.style.color="var(--text2)"; }}>
      {children}
    </button>
  );
}

function ProgressBar({ value, max, color="var(--brand)", height=5 }) {
  const w = Math.min(100, Math.round((value / (max||1)) * 100));
  return (
    <div style={{ height, borderRadius: height/2, background: "var(--bg3)", overflow: "hidden" }}>
      <div style={{ height:"100%", width:`${w}%`, borderRadius:height/2, background:color, transition:"width 0.9s cubic-bezier(0.16,1,0.3,1)" }} />
    </div>
  );
}

function DonutRing({ value, max, color, size=80, label }) {
  const r=28, cx=40, cy=40, circ=2*Math.PI*r;
  const dash = circ*(pct(value,max)/100);
  return (
    <div style={{ textAlign:"center" }}>
      <svg width={size} height={size} viewBox="0 0 80 80">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1a1a28" strokeWidth="8"/>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="8"
          strokeDasharray={`${dash} ${circ}`} strokeDashoffset={circ/4}
          strokeLinecap="round" style={{transition:"stroke-dasharray 1s ease"}}/>
        <text x={cx} y={cy+5} textAnchor="middle" fill="#fff" fontSize="13" fontWeight="700" fontFamily="Bebas Neue,sans-serif">{pct(value,max)}%</text>
      </svg>
      {label && <div style={{ fontSize:10, color:"#9090b8", marginTop:2 }}>{label}</div>}
    </div>
  );
}

function HeartRateOrb({ bpm, loading }) {
  const color = bpm>120?"var(--brand)":bpm>80?"var(--brand2)":"#4ade80";
  return (
    <div style={{ width:110, height:110, borderRadius:"50%", background:`radial-gradient(circle at 40% 35%,${color}33,${color}08)`, border:`2px solid ${color}44`, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", boxShadow:`0 0 30px ${color}22`, animation:bpm>0?"heartbeat 0.9s ease infinite":"none" }}>
      <div style={{ fontSize:20 }}>❤️</div>
      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:30, color, lineHeight:1 }}>{loading?"–":bpm||"–"}</div>
      <div style={{ fontSize:9, color:"#9090b8", letterSpacing:1 }}>BPM</div>
    </div>
  );
}

function WearableRing({ value, max, color, size=78, label, unit }) {
  const r=28, cx=39, cy=39, circ=2*Math.PI*r;
  const p=Math.min(100,Math.round((value/(max||1))*100));
  const dash=circ*(p/100);
  return (
    <div style={{ textAlign:"center" }}>
      <svg width={size} height={size} viewBox="0 0 78 78">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1a1a28" strokeWidth="8"/>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="8" strokeDasharray={`${dash} ${circ}`} strokeDashoffset={circ/4} strokeLinecap="round" style={{transition:"stroke-dasharray 1s ease"}}/>
        <text x={cx} y={cy+5} textAnchor="middle" fill="#fff" fontSize="12" fontWeight="700" fontFamily="Bebas Neue,sans-serif">{p}%</text>
      </svg>
      <div style={{ fontSize:12, fontWeight:700, color, marginTop:2 }}>{typeof value==="number"?value.toLocaleString():value}</div>
      <div style={{ fontSize:10, color:"#9090b8" }}>{unit ? `${label} · ${unit}` : label}</div>
    </div>
  );
}

function Sparkline({ data=[], color="var(--brand)", height=60 }) {
  if (data.length < 2) return <div style={{ height }} />;
  const W=300, H=height, p=6;
  const mn=Math.min(...data), mx=Math.max(...data), rng=mx-mn||1;
  const pts = data.map((v,i)=>[p+i*((W-p*2)/(data.length-1)), p+(1-(v-mn)/rng)*(H-p*2)]);
  const path = "M"+pts.map(([x,y])=>`${x},${y}`).join(" L");
  const fill = path+` L${pts[pts.length-1][0]},${H} L${pts[0][0]},${H} Z`;
  const id = `sg${color.replace("#","")}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35"/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <path d={fill} fill={`url(#${id})`}/>
      <path d={path} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx={pts[pts.length-1][0]} cy={pts[pts.length-1][1]} r="5" fill={color} stroke="var(--bg)" strokeWidth="2"/>
    </svg>
  );
}

function BarChart({ data=[], labels=[], color="var(--brand)" }) {
  const max = Math.max(...data)||1;
  return (
    <div style={{ display:"flex", alignItems:"flex-end", gap:5, height:70 }}>
      {data.map((v,i)=>(
        <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:4 }}>
          <div style={{ fontSize:8, color:"#9090b8" }}>{v}</div>
          <div style={{ width:"100%", height:(v/max)*50+4, borderRadius:"3px 3px 0 0", background:i===data.length-1?`linear-gradient(${color},${color}88)`:"var(--border)", transition:"height 0.6s" }}/>
          <div style={{ fontSize:8, color:"#8080a8" }}>{labels[i]}</div>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AGE BRACKET DATA
// ─────────────────────────────────────────────────────────────────────────────
const AGE_BRACKETS = [
  { v:"18-29", label:"18 \u2013 29", sub:"Peak performance years", accent:"#ff3d2e", bg:"linear-gradient(160deg,#180806 0%,#2a0d08 50%,#0c0c20 100%)", image:"/age-18.jpg" },
  { v:"30-39", label:"30 \u2013 39", sub:"Build strength & endurance", accent:"#4ade80", bg:"linear-gradient(160deg,#061208 0%,#0a1e0e 50%,#0c0c1e 100%)", image:"/age-30.jpg" },
  { v:"40-49", label:"40 \u2013 49", sub:"Maintain & strengthen", accent:"#a78bfa", bg:"linear-gradient(160deg,#0c0818 0%,#160a2a 50%,#0c0e18 100%)", image:"/age-40.jpg" },
  { v:"50+",   label:"50+",          sub:"Longevity & vitality", accent:"#00e5ff", bg:"linear-gradient(160deg,#050e14 0%,#071824 50%,#060e08 100%)", image:"/age-50.jpg" },
];

// ─────────────────────────────────────────────────────────────────────────────
// ONBOARDING
// ─────────────────────────────────────────────────────────────────────────────
function Onboarding({ onDone }) {
  const [phase, setPhase]   = useState("hero");   // "hero" | "age" | "steps"
  const [step, setStep]     = useState(0);
  const [profile, setProfile] = useState({});
  const [input, setInput]   = useState("");
  const s = ONBOARDING[step];

  const advance = (val) => {
    const v = val || input;
    if (!v) return;
    const np = { ...profile, [s.key]: v };
    setProfile(np);
    setInput("");
    if (step < ONBOARDING.length-1) setStep(st=>st+1);
    else onDone(np);
  };

  const pickAge = (bracket) => {
    setProfile(p=>({...p, age: bracket}));
    setPhase("steps");
  };

  const CSS = `
    @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Syne:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap');
    *{box-sizing:border-box;margin:0;padding:0}
    :root{--brand:#ff3d2e;--brand2:#e06800;--bg:#06060e;--bg2:#111120;--border2:#28283f;--text:#ece8e1;--text2:#a8a8c8;--text3:#7070a0;--grad:linear-gradient(135deg,#ff3d2e,#e06800)}
    input{background:rgba(255,255,255,0.05);border:1px solid #28283f;border-radius:12px;padding:13px 16px;color:#ece8e1;font-family:'Syne',sans-serif;font-size:15px;outline:none;width:100%;transition:border-color 0.2s,box-shadow 0.2s}
    input:focus{border-color:#ff3d2e;box-shadow:0 0 0 3px rgba(255,61,46,0.12)}
    @keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
    @keyframes popIn{from{opacity:0;transform:scale(0.94)}to{opacity:1;transform:scale(1)}}
    .hero-title{animation:fadeUp 0.6s cubic-bezier(0.16,1,0.3,1) forwards}
    .hero-sub{animation:fadeUp 0.6s 0.1s cubic-bezier(0.16,1,0.3,1) both}
    .age-grid{animation:fadeUp 0.5s 0.2s cubic-bezier(0.16,1,0.3,1) both}
    .age-card{transition:transform 0.2s,box-shadow 0.2s}
    .age-card:hover{transform:scale(1.03);box-shadow:0 20px 60px rgba(0,0,0,0.5)}
    .age-card:active{transform:scale(0.97)}
  `;

  const BASE = {
    minHeight:"100vh", background:"#06060e", fontFamily:"'Syne',sans-serif",
    position:"relative", overflowX:"hidden", overflowY:"auto",
  };

  // ── HERO SCREEN ──
  if (phase === "hero") return (
    <div style={BASE}>
      <style>{CSS}</style>
      {/* Background mesh */}
      <div style={{ position:"fixed", inset:0, pointerEvents:"none" }}>
        <div style={{ position:"absolute", top:"-10%", left:"50%", transform:"translateX(-50%)", width:"140%", height:"60%", background:"radial-gradient(ellipse,rgba(255,61,46,0.12) 0%,transparent 65%)" }}/>
        <div style={{ position:"absolute", inset:0, backgroundImage:"repeating-linear-gradient(45deg,rgba(255,255,255,0.012) 0px,rgba(255,255,255,0.012) 1px,transparent 1px,transparent 28px)" }}/>
      </div>

      <div style={{ position:"relative", zIndex:1, display:"flex", flexDirection:"column", alignItems:"center", padding:"60px 24px 40px" }}>
        {/* Logo */}
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:52 }}>
          <div style={{ width:38, height:38, background:"linear-gradient(135deg,#ff3d2e,#e06800)", borderRadius:11, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 6px 20px rgba(255,61,46,0.4)" }}>
            <Zap size={20} color="#fff" strokeWidth={2.5}/>
          </div>
          <span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:22, letterSpacing:1.5, textTransform:"uppercase", color:"#ece8e1" }}>APEX FIT PRO</span>
        </div>

        {/* Big headline */}
        <div className="hero-title" style={{ textAlign:"center", marginBottom:16 }}>
          <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:"clamp(52px,14vw,80px)", lineHeight:0.9, textTransform:"uppercase", color:"#ece8e1", letterSpacing:-1 }}>
            BUILD YOUR<br/>
            <span style={{ background:"linear-gradient(135deg,#ff3d2e,#e06800)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>PERFECT</span><br/>
            BODY
          </div>
        </div>
        <div className="hero-sub" style={{ fontFamily:"'Syne',sans-serif", fontSize:15, color:"#7070a0", textAlign:"center", marginBottom:52, letterSpacing:0.3 }}>
          A personalised plan built around your age,<br/>goals and fitness level
        </div>

        {/* CTA */}
        <button onClick={()=>setPhase("age")}
          style={{ background:"linear-gradient(135deg,#ff3d2e,#e06800)", border:"none", color:"#fff", borderRadius:16, padding:"18px 52px", fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:20, letterSpacing:1.5, textTransform:"uppercase", cursor:"pointer", boxShadow:"0 8px 32px rgba(255,61,46,0.45)", marginBottom:20, transition:"all 0.2s" }}
          onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-2px)";e.currentTarget.style.boxShadow="0 12px 40px rgba(255,61,46,0.55)"}}
          onMouseLeave={e=>{e.currentTarget.style.transform="none";e.currentTarget.style.boxShadow="0 8px 32px rgba(255,61,46,0.45)"}}>
          GET STARTED →
        </button>

        {/* Feature pills */}
        <div style={{ display:"flex", gap:10, flexWrap:"wrap", justifyContent:"center", marginTop:8 }}>
          {["AI Coach","Food Scanner","Wearable Sync","Custom Plans"].map(f=>(
            <div key={f} style={{ padding:"6px 14px", borderRadius:100, border:"1px solid rgba(255,255,255,0.08)", fontSize:12, color:"#7070a0", fontFamily:"'Syne',sans-serif", display:"flex", alignItems:"center", gap:6 }}>
              <div style={{ width:5, height:5, borderRadius:"50%", background:"#ff3d2e" }}/>
              {f}
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  // ── AGE BRACKET SCREEN ──
  if (phase === "age") return (
    <div style={BASE}>
      <style>{CSS}</style>
      <div style={{ position:"fixed", inset:0, pointerEvents:"none" }}>
        <div style={{ position:"absolute", top:"-10%", left:"50%", transform:"translateX(-50%)", width:"140%", height:"50%", background:"radial-gradient(ellipse,rgba(255,61,46,0.08) 0%,transparent 65%)" }}/>
        <div style={{ position:"absolute", inset:0, backgroundImage:"repeating-linear-gradient(45deg,rgba(255,255,255,0.01) 0px,rgba(255,255,255,0.01) 1px,transparent 1px,transparent 28px)" }}/>
      </div>

      <div style={{ position:"relative", zIndex:1, padding:"40px 20px 40px" }}>
        {/* Back + logo row */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:40 }}>
          <button onClick={()=>setPhase("hero")} style={{ background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:10, padding:"8px 14px", color:"#7070a0", fontFamily:"'Syne',sans-serif", fontSize:13, cursor:"pointer", display:"flex", alignItems:"center", gap:6 }}>
            ← Back
          </button>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ width:28, height:28, background:"linear-gradient(135deg,#ff3d2e,#e06800)", borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center" }}><Zap size={14} color="#fff" strokeWidth={2.5}/></div>
            <span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:16, letterSpacing:1, textTransform:"uppercase", color:"#ece8e1" }}>APEX FIT</span>
          </div>
        </div>

        {/* Headline */}
        <div className="hero-title" style={{ textAlign:"center", marginBottom:8 }}>
          <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:"clamp(38px,10vw,56px)", lineHeight:0.92, textTransform:"uppercase", color:"#ece8e1", letterSpacing:-0.5 }}>
            SELECT YOUR<br/><span style={{ background:"linear-gradient(135deg,#ff3d2e,#e06800)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>AGE GROUP</span>
          </div>
        </div>
        <div className="hero-sub" style={{ textAlign:"center", fontSize:14, color:"#7070a0", marginBottom:32 }}>
          We'll tailor your plan to your body's needs
        </div>

        {/* Age cards grid */}
        <div className="age-grid" style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, maxWidth:480, margin:"0 auto" }}>
          {AGE_BRACKETS.map(ab=>(
            <button key={ab.v} className="age-card" onClick={()=>pickAge(ab.v)}
              style={{ position:"relative", height:220, borderRadius:20, overflow:"hidden", border:`1px solid ${ab.accent}44`, cursor:"pointer", padding:0, background:ab.bg }}>
              {/* Cartoon illustration */}
              <img src={ab.image} alt="" onError={(e)=>{e.currentTarget.style.display="none";}}
                style={{ position:"absolute", inset:0, width:"100%", height:"100%", objectFit:"cover", objectPosition:"center" }}/>
              {/* Subtle bottom fade for text legibility */}
              <div style={{ position:"absolute", inset:0, background:"linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.1) 45%, transparent 100%)" }}/>
              {/* Top accent line */}
              <div style={{ position:"absolute", top:0, left:0, right:0, height:3, background:`linear-gradient(90deg,${ab.accent},${ab.accent}55)` }}/>
              {/* Label */}
              <div style={{ position:"absolute", bottom:0, left:0, right:0, padding:"14px 16px", display:"flex", alignItems:"flex-end", justifyContent:"space-between" }}>
                <div style={{ textAlign:"left" }}>
                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:24, color:"#fff", letterSpacing:0.5, lineHeight:1, textShadow:"0 2px 8px rgba(0,0,0,0.8)" }}>{ab.label}</div>
                  <div style={{ fontFamily:"'Syne',sans-serif", fontSize:10, color:"rgba(255,255,255,0.6)", marginTop:3 }}>{ab.sub}</div>
                </div>
                <div style={{ width:30, height:30, borderRadius:"50%", background:ab.accent, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, boxShadow:`0 4px 12px ${ab.accent}88` }}>
                  <ChevronRight size={15} color="#fff" strokeWidth={2.5}/>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  // ── STEP-BY-STEP QUESTIONS ──
  return (
    <div style={{ ...BASE, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:24 }}>
      <style>{CSS}</style>
      <div style={{ position:"fixed", inset:0, pointerEvents:"none" }}>
        <div style={{ position:"absolute", top:"-10%", left:"50%", transform:"translateX(-50%)", width:"120%", height:"50%", background:"radial-gradient(ellipse,rgba(255,61,46,0.07) 0%,transparent 65%)" }}/>
        <div style={{ position:"absolute", inset:0, backgroundImage:"repeating-linear-gradient(45deg,rgba(255,255,255,0.01) 0px,rgba(255,255,255,0.01) 1px,transparent 1px,transparent 28px)" }}/>
      </div>

      <div style={{ width:"100%", maxWidth:420, position:"relative", zIndex:1 }}>
        {/* Logo */}
        <div style={{ textAlign:"center", marginBottom:36 }}>
          <div style={{ display:"inline-flex", alignItems:"center", gap:9, marginBottom:10 }}>
            <div style={{ width:32, height:32, background:"linear-gradient(135deg,#ff3d2e,#e06800)", borderRadius:9, display:"flex", alignItems:"center", justifyContent:"center" }}><Zap size={16} color="#fff" strokeWidth={2.5}/></div>
            <span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:18, letterSpacing:1.5, textTransform:"uppercase", color:"#ece8e1" }}>APEX FIT PRO</span>
          </div>
          {/* Selected age badge */}
          {profile.age && (
            <div style={{ display:"inline-flex", alignItems:"center", gap:6, background:"rgba(255,61,46,0.1)", border:"1px solid rgba(255,61,46,0.25)", borderRadius:100, padding:"4px 12px", marginTop:4 }}>
              <div style={{ width:5, height:5, borderRadius:"50%", background:"#ff3d2e" }}/>
              <span style={{ fontFamily:"'Syne',sans-serif", fontSize:11, color:"#ff3d2e", fontWeight:600 }}>Age {profile.age}</span>
            </div>
          )}
        </div>

        {/* Step progress dots */}
        <div style={{ display:"flex", gap:6, marginBottom:36 }}>
          {ONBOARDING.map((_,i) => (
            <div key={i} style={{ flex:1, height:3, borderRadius:2, background: i<=step ? "linear-gradient(90deg,#ff3d2e,#e06800)" : "rgba(255,255,255,0.06)", transition:"background 0.4s" }}/>
          ))}
        </div>

        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:28, color:"#ece8e1", textTransform:"uppercase", letterSpacing:0.5, marginBottom:4, lineHeight:1.1 }}>{s.q}</div>
        <div style={{ fontFamily:"'Syne',sans-serif", fontSize:11, color:"#7070a0", marginBottom:26, letterSpacing:2, textTransform:"uppercase" }}>STEP {step+1} / {ONBOARDING.length}</div>

        {s.type==="text"||s.type==="number" ? (
          <>
            <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&advance()} type={s.type==="number"?"number":"text"} placeholder={s.ph} style={{ marginBottom:14 }}/>
            <button onClick={()=>advance()} disabled={!input}
              style={{ width:"100%", background:input?"linear-gradient(135deg,#ff3d2e,#e06800)":"rgba(255,255,255,0.04)", border:input?"none":"1px solid rgba(255,255,255,0.06)", color:input?"#fff":"#3e3e5a", borderRadius:12, padding:14, fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:16, letterSpacing:1, textTransform:"uppercase", cursor:input?"pointer":"default", boxShadow:input?"0 6px 24px rgba(255,61,46,0.3)":"none", transition:"all 0.2s" }}>
              {step===ONBOARDING.length-1 ? "LET'S GO 🚀" : "CONTINUE →"}
            </button>
          </>
        ) : (
          <div style={{ display:"grid", gridTemplateColumns:s.opts.length>3?"1fr 1fr":"1fr", gap:10 }}>
            {s.opts.map(o=>(
              <button key={o.v} onClick={()=>advance(o.v)}
                style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:14, padding:"16px 18px", color:"#ece8e1", fontFamily:"'Syne',sans-serif", fontSize:14, fontWeight:600, cursor:"pointer", textAlign:"left", transition:"all 0.18s", backdropFilter:"blur(8px)" }}
                onMouseEnter={e=>{e.currentTarget.style.borderColor="#ff3d2e";e.currentTarget.style.background="rgba(255,61,46,0.08)"}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor="rgba(255,255,255,0.08)";e.currentTarget.style.background="rgba(255,255,255,0.03)"}}>
                {o.l}
              </button>
            ))}
          </div>
        )}

        <button onClick={()=>setPhase("age")} style={{ marginTop:24, background:"none", border:"none", color:"#7070a0", fontFamily:"'Syne',sans-serif", fontSize:12, cursor:"pointer", display:"block", textAlign:"center", width:"100%" }}>
          ← Change age group
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKOUT CARD
// ─────────────────────────────────────────────────────────────────────────────
function WorkoutCard({ w, done, onStart }) {
  const typeIcon = { HIIT:<Zap size={18} strokeWidth={2.5}/>, Strength:<Dumbbell size={18} strokeWidth={2}/>, Core:<Target size={18} strokeWidth={2}/>, Cardio:<Activity size={18} strokeWidth={2}/>, Flexibility:<Wind size={18} strokeWidth={2}/>, Custom:<Settings size={18} strokeWidth={2}/> };
  const c = TC[w.type]||"var(--brand)";
  return (
    <div className="glass" style={{ padding:18, marginBottom:10, opacity:done?0.55:1, position:"relative", overflow:"hidden", transition:"all 0.2s" }}>
      {/* Type accent bar */}
      <div style={{ position:"absolute", top:0, left:0, width:3, height:"100%", background:`linear-gradient(180deg,${c},${c}44)`, borderRadius:"20px 0 0 20px" }}/>
      {done && (
        <div style={{ position:"absolute", top:12, right:12, background:"rgba(74,222,128,0.15)", border:"1px solid rgba(74,222,128,0.3)", color:"#4ade80", padding:"2px 10px", borderRadius:100, fontFamily:"'Barlow Condensed',sans-serif", fontSize:11, fontWeight:700, letterSpacing:1 }}>✓ DONE</div>
      )}
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:10, paddingLeft:8 }}>
        <div style={{ width:42, height:42, borderRadius:12, background:`${c}18`, border:`1px solid ${c}30`, display:"flex", alignItems:"center", justifyContent:"center", color:c, flexShrink:0 }}>{typeIcon[w.type]||<Dumbbell size={18}/>}</div>
        <div>
          <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:18, textTransform:"uppercase", letterSpacing:0.3, color:"var(--text)", lineHeight:1 }}>{w.name}</div>
          <div style={{ display:"flex", gap:7, marginTop:4 }}>
            <span className="pill" style={{ background:`${c}18`, color:c, border:`1px solid ${c}30` }}>{w.type}</span>
            <span style={{ fontFamily:"'Syne',sans-serif", fontSize:11, color:"var(--text3)", alignSelf:"center" }}>{w.difficulty}</span>
          </div>
        </div>
      </div>
      <div style={{ display:"flex", gap:16, marginBottom:10, paddingLeft:8 }}>
        <span style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:12, color:"var(--text2)" }}>⏱ {w.duration}m</span>
        <span style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:12, color:"var(--text2)" }}>🔥 {w.calories} kcal</span>
      </div>
      <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginBottom:14, paddingLeft:8 }}>
        {w.exercises.slice(0,4).map(e=>(
          <span key={e} style={{ padding:"3px 9px", borderRadius:100, fontSize:10, fontWeight:600, background:"rgba(255,255,255,0.04)", color:"var(--text3)", border:"1px solid var(--border)", fontFamily:"'Syne',sans-serif" }}>{e}</span>
        ))}
        {w.exercises.length>4 && <span style={{ padding:"3px 9px", borderRadius:100, fontSize:10, background:"rgba(255,255,255,0.04)", color:"var(--text3)", border:"1px solid var(--border)", fontFamily:"'Syne',sans-serif" }}>+{w.exercises.length-4}</span>}
      </div>
      {!done && <PrimaryBtn onClick={()=>onStart(w)} style={{ padding:"10px", fontSize:14 }}>START →</PrimaryBtn>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STRENGTH DIARY
// ─────────────────────────────────────────────────────────────────────────────
const RESISTANCE_EXERCISES = [
  "Bench Press","Incline Bench Press","Decline Bench Press","Dumbbell Fly",
  "Overhead Press","Arnold Press","Lateral Raise","Front Raise",
  "Barbell Row","Dumbbell Row","Lat Pulldown","Pull-ups","Seated Cable Row",
  "Deadlift","Romanian Deadlift","Sumo Deadlift",
  "Squat","Front Squat","Hack Squat","Leg Press","Leg Curl","Leg Extension",
  "Hip Thrust","Glute Bridge","Calf Raise",
  "Bicep Curl","Hammer Curl","Preacher Curl","Concentration Curl",
  "Tricep Pushdown","Skull Crusher","Overhead Tricep Extension","Dips",
  "Face Pull","Shrugs","Upright Row","Ab Wheel","Push-ups","Plank",
];

function StrengthDiary({ strengthLog, setStrengthLog }) {
  const [diaryView,     setDiaryView]     = useState("log");
  const [diaryExercise, setDiaryExercise] = useState("Bench Press");
  const [diarySets,     setDiarySets]     = useState([{reps:"",weight:""}]);
  const [diaryNote,     setDiaryNote]     = useState("");
  const today = new Date().toISOString().slice(0,10);

  const saveDiaryEntry = () => {
    const validSets = diarySets.filter(s=>s.weight&&s.reps);
    if (!validSets.length) return;
    setStrengthLog(prev=>[{
      id: Date.now(), date: today, exercise: diaryExercise,
      sets: validSets.map(s=>({reps:parseInt(s.reps),weight:parseFloat(s.weight)})),
      note: diaryNote.trim(),
    }, ...prev].slice(0,500));
    setDiarySets([{reps:"",weight:""}]);
    setDiaryNote("");
  };

  const exerciseHistory = [...strengthLog.filter(e=>e.exercise===diaryExercise)].reverse();
  const allBests = strengthLog.filter(e=>e.exercise===diaryExercise).map(e=>Math.max(...e.sets.map(s=>s.weight)));
  const pr = allBests.length ? Math.max(...allBests) : 0;
  const bestPerSession = exerciseHistory.map(e=>({
    date: e.date,
    weight: Math.max(...e.sets.map(s=>s.weight)),
    reps: e.sets.find(s=>s.weight===Math.max(...e.sets.map(s=>s.weight)))?.reps||0,
    volume: e.sets.reduce((a,s)=>a+s.weight*s.reps,0),
  }));
  const loggedExercises = [...new Set(strengthLog.map(e=>e.exercise))];

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      {/* View toggle */}
      <div style={{ display:"flex", gap:6 }}>
        {[{id:"log",label:"Log Entry"},{id:"history",label:"Progression"}].map(v=>(
          <button key={v.id} onClick={()=>setDiaryView(v.id)}
            style={{ flex:1, padding:"9px 0", borderRadius:10, border:`1px solid ${diaryView===v.id?"var(--brand)":"var(--border2)"}`, background:diaryView===v.id?"rgba(255,61,46,0.12)":"transparent", color:diaryView===v.id?"var(--brand)":"var(--text3)", fontFamily:"'Syne',sans-serif", fontWeight:700, fontSize:12, cursor:"pointer", transition:"all 0.2s" }}>
            {v.label}
          </button>
        ))}
      </div>

      {/* ── LOG ENTRY ── */}
      {diaryView==="log" && (
        <>
          <Card style={{ padding:18 }}>
            <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:16, textTransform:"uppercase", letterSpacing:0.5, marginBottom:14 }}>Log Resistance Set</div>
            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:11, color:"var(--text3)", marginBottom:6, fontWeight:700, textTransform:"uppercase", letterSpacing:1 }}>Exercise</div>
              <select value={diaryExercise} onChange={e=>setDiaryExercise(e.target.value)}
                style={{ width:"100%", background:"rgba(255,255,255,0.03)", border:"1px solid var(--border2)", borderRadius:10, padding:"10px 12px", color:"var(--text)", fontFamily:"'Syne',sans-serif", fontSize:13, outline:"none" }}>
                {RESISTANCE_EXERCISES.map(ex=><option key={ex} value={ex}>{ex}</option>)}
              </select>
            </div>
            {pr > 0 && (
              <div style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 12px", background:"rgba(255,215,0,0.08)", border:"1px solid rgba(255,215,0,0.2)", borderRadius:10, marginBottom:14 }}>
                <Trophy size={14} color="#ffd700" strokeWidth={2}/>
                <span style={{ fontSize:12, color:"#ffd700", fontFamily:"'Syne',sans-serif", fontWeight:700 }}>Current PR: {pr}kg</span>
                {bestPerSession.length>1 && (
                  <span style={{ fontSize:11, color:"var(--text3)", marginLeft:"auto" }}>
                    {bestPerSession[bestPerSession.length-1]?.weight > bestPerSession[bestPerSession.length-2]?.weight ? "↑ Improving" : "→ Maintaining"}
                  </span>
                )}
              </div>
            )}
            {/* Sets header */}
            <div style={{ display:"grid", gridTemplateColumns:"28px 1fr 1fr 28px", gap:6, marginBottom:6, alignItems:"center" }}>
              <div style={{ fontSize:10, color:"var(--text3)", textAlign:"center" }}>#</div>
              <div style={{ fontSize:10, color:"var(--text3)", textAlign:"center" }}>kg</div>
              <div style={{ fontSize:10, color:"var(--text3)", textAlign:"center" }}>Reps</div>
              <div/>
            </div>
            {diarySets.map((set,i)=>(
              <div key={i} style={{ display:"grid", gridTemplateColumns:"28px 1fr 1fr 28px", gap:6, marginBottom:6, alignItems:"center" }}>
                <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:15, color:"var(--brand)", textAlign:"center" }}>{i+1}</div>
                <input type="number" placeholder="80" value={set.weight}
                  onChange={e=>setDiarySets(p=>p.map((s,j)=>j===i?{...s,weight:e.target.value}:s))}
                  style={{ background:"rgba(255,255,255,0.04)", border:"1px solid var(--border2)", borderRadius:9, padding:"9px 8px", color:"var(--text)", fontFamily:"'JetBrains Mono',monospace", fontSize:14, fontWeight:600, textAlign:"center", outline:"none", width:"100%", boxSizing:"border-box" }}/>
                <input type="number" placeholder="10" value={set.reps}
                  onChange={e=>setDiarySets(p=>p.map((s,j)=>j===i?{...s,reps:e.target.value}:s))}
                  style={{ background:"rgba(255,255,255,0.04)", border:"1px solid var(--border2)", borderRadius:9, padding:"9px 8px", color:"var(--text)", fontFamily:"'JetBrains Mono',monospace", fontSize:14, fontWeight:600, textAlign:"center", outline:"none", width:"100%", boxSizing:"border-box" }}/>
                <button onClick={()=>setDiarySets(p=>p.length>1?p.filter((_,j)=>j!==i):p)}
                  style={{ width:26, height:26, borderRadius:7, background:"rgba(255,61,46,0.1)", border:"1px solid rgba(255,61,46,0.2)", color:"var(--brand)", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>
                  <X size={11} strokeWidth={2.5}/>
                </button>
              </div>
            ))}
            <button onClick={()=>setDiarySets(p=>[...p,{reps:"",weight:""}])}
              style={{ width:"100%", padding:"9px 0", borderRadius:10, border:"1px dashed var(--border2)", background:"transparent", color:"var(--text3)", fontFamily:"'Syne',sans-serif", fontWeight:700, fontSize:12, cursor:"pointer", margin:"6px 0 14px", display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
              <Plus size={13} strokeWidth={2.5}/> Add Set
            </button>
            <textarea value={diaryNote} onChange={e=>setDiaryNote(e.target.value)}
              placeholder="Notes… e.g. felt strong, slight shoulder tweak" rows={2}
              style={{ width:"100%", background:"rgba(255,255,255,0.03)", border:"1px solid var(--border2)", borderRadius:10, padding:"10px 12px", color:"var(--text)", fontFamily:"'Syne',sans-serif", fontSize:12, outline:"none", resize:"none", marginBottom:14, boxSizing:"border-box" }}/>
            <PrimaryBtn onClick={saveDiaryEntry} disabled={!diarySets.some(s=>s.weight&&s.reps)}
              style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8, fontSize:14 }}>
              <CheckCircle2 size={15} strokeWidth={2}/> Save Entry
            </PrimaryBtn>
          </Card>

          {/* Recent all exercises */}
          {strengthLog.length > 0 && (
            <Card style={{ padding:16 }}>
              <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:15, textTransform:"uppercase", letterSpacing:0.5, marginBottom:12 }}>Recent Entries</div>
              {strengthLog.slice(0,8).map((entry,i)=>(
                <div key={entry.id||i} style={{ padding:"10px 0", borderBottom:i<Math.min(strengthLog.length,8)-1?"1px solid var(--border)":"none" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                    <div style={{ fontFamily:"'Syne',sans-serif", fontWeight:700, fontSize:13 }}>{entry.exercise}</div>
                    <div style={{ fontSize:10, color:"var(--text3)" }}>{entry.date}</div>
                  </div>
                  <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
                    {entry.sets.map((s,j)=>(
                      <div key={j} style={{ padding:"3px 9px", borderRadius:20, background:"rgba(255,255,255,0.04)", border:"1px solid var(--border2)", fontSize:11, fontFamily:"'JetBrains Mono',monospace", color:"var(--text2)" }}>
                        {s.weight}kg × {s.reps}
                      </div>
                    ))}
                  </div>
                  {entry.note && <div style={{ fontSize:11, color:"var(--text3)", marginTop:4, fontStyle:"italic" }}>{entry.note}</div>}
                </div>
              ))}
            </Card>
          )}
        </>
      )}

      {/* ── PROGRESSION ── */}
      {diaryView==="history" && (
        <>
          <Card style={{ padding:14 }}>
            <div style={{ fontSize:11, color:"var(--text3)", marginBottom:8, fontWeight:700, textTransform:"uppercase", letterSpacing:1 }}>Tracking exercise</div>
            {loggedExercises.length ? (
              <select value={diaryExercise} onChange={e=>setDiaryExercise(e.target.value)}
                style={{ width:"100%", background:"rgba(255,255,255,0.03)", border:"1px solid var(--border2)", borderRadius:10, padding:"10px 12px", color:"var(--text)", fontFamily:"'Syne',sans-serif", fontSize:13, outline:"none" }}>
                {loggedExercises.map(ex=><option key={ex} value={ex}>{ex}</option>)}
              </select>
            ) : (
              <div style={{ color:"var(--text3)", fontSize:12 }}>No entries yet — log some sets first.</div>
            )}
          </Card>

          {exerciseHistory.length === 0 ? (
            <Card style={{ padding:24, textAlign:"center" }}>
              <Dumbbell size={32} color="var(--text3)" strokeWidth={1.5} style={{ marginBottom:10 }}/>
              <div style={{ color:"var(--text3)", fontSize:13 }}>No entries for {diaryExercise} yet.</div>
            </Card>
          ) : (
            <>
              {/* Stats row */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
                {[
                  { label:"Personal Best", val:`${pr}kg`, color:"#ffd700", Icon:Trophy },
                  { label:"Sessions", val:strengthLog.filter(e=>e.exercise===diaryExercise).length, color:"#4ade80", Icon:Activity },
                  { label:"Last Top Set", val:`${bestPerSession[bestPerSession.length-1]?.weight||0}kg`, color:"var(--brand)", Icon:Dumbbell },
                ].map(s=>(
                  <Card key={s.label} style={{ padding:12, textAlign:"center" }}>
                    <s.Icon size={15} color={s.color} strokeWidth={2} style={{ marginBottom:4 }}/>
                    <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:20, fontWeight:900, color:s.color }}>{s.val}</div>
                    <div style={{ fontSize:9, color:"var(--text3)", marginTop:2, lineHeight:1.3 }}>{s.label}</div>
                  </Card>
                ))}
              </div>

              {/* Weight progression chart */}
              <Card style={{ padding:16 }}>
                <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:15, textTransform:"uppercase", letterSpacing:0.5, marginBottom:2 }}>Weight Progression</div>
                <div style={{ fontSize:11, color:"var(--text3)", marginBottom:14 }}>Top set per session (kg)</div>
                {bestPerSession.length > 1 ? (
                  <>
                    <div style={{ display:"flex", alignItems:"flex-end", gap:5, height:100, marginBottom:8 }}>
                      {bestPerSession.map((s,i)=>{
                        const max = Math.max(...bestPerSession.map(x=>x.weight));
                        const min = Math.min(...bestPerSession.map(x=>x.weight));
                        const h = 20 + ((s.weight-min)/(max-min||1))*76;
                        const isLatest = i===bestPerSession.length-1;
                        const isPR = s.weight===pr;
                        return (
                          <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:3 }}>
                            {isPR && <div style={{ fontSize:8, color:"#ffd700" }}>PR</div>}
                            <div style={{ width:"100%", borderRadius:"5px 5px 3px 3px", background:isPR?"#ffd700":isLatest?"var(--brand)":"rgba(255,61,46,0.35)", height:`${h}px`, transition:"height 0.5s", minHeight:8, boxShadow:isLatest?"0 0 10px rgba(255,61,46,0.4)":"none" }}/>
                            <div style={{ fontSize:9, fontFamily:"'JetBrains Mono',monospace", color:isPR?"#ffd700":isLatest?"var(--brand)":"var(--text3)", fontWeight:600 }}>{s.weight}</div>
                            <div style={{ fontSize:8, color:"var(--text3)" }}>{s.date.slice(5)}</div>
                          </div>
                        );
                      })}
                    </div>
                    {(()=>{
                      const first = bestPerSession[0].weight;
                      const last  = bestPerSession[bestPerSession.length-1].weight;
                      const diff  = last - first;
                      return (
                        <div style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 12px", background:diff>=0?"rgba(74,222,128,0.08)":"rgba(255,61,46,0.08)", border:`1px solid ${diff>=0?"rgba(74,222,128,0.2)":"rgba(255,61,46,0.2)"}`, borderRadius:10 }}>
                          <TrendingDown size={13} color={diff>=0?"#4ade80":"#ff3d2e"} strokeWidth={2} style={{ transform:diff>=0?"rotate(180deg)":"none" }}/>
                          <span style={{ fontSize:12, color:diff>=0?"#4ade80":"#ff3d2e", fontWeight:700 }}>
                            {diff>=0?"+":""}{diff.toFixed(1)}kg across {bestPerSession.length} sessions
                          </span>
                        </div>
                      );
                    })()}
                  </>
                ) : (
                  <div style={{ textAlign:"center", color:"var(--text3)", fontSize:12, padding:"16px 0" }}>Log 2+ sessions to see progression chart</div>
                )}
              </Card>

              {/* Volume chart */}
              {bestPerSession.length > 1 && (
                <Card style={{ padding:16 }}>
                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:15, textTransform:"uppercase", letterSpacing:0.5, marginBottom:2 }}>Volume per Session</div>
                  <div style={{ fontSize:11, color:"var(--text3)", marginBottom:14 }}>Total kg lifted (sets × reps × weight)</div>
                  <div style={{ display:"flex", alignItems:"flex-end", gap:5, height:80 }}>
                    {bestPerSession.map((s,i)=>{
                      const maxV = Math.max(...bestPerSession.map(x=>x.volume));
                      return (
                        <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:3 }}>
                          <div style={{ width:"100%", borderRadius:"4px 4px 2px 2px", background:"rgba(167,139,250,0.55)", height:`${Math.max((s.volume/maxV)*70,6)}px`, transition:"height 0.5s" }}/>
                          <div style={{ fontSize:8, color:"var(--text3)" }}>{Math.round(s.volume)}kg</div>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              )}

              {/* Session history */}
              <Card style={{ padding:16 }}>
                <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:15, textTransform:"uppercase", letterSpacing:0.5, marginBottom:12 }}>Session History</div>
                {[...exerciseHistory].reverse().map((entry,i)=>(
                  <div key={entry.id||i} style={{ padding:"12px 0", borderBottom:i<exerciseHistory.length-1?"1px solid var(--border)":"none" }}>
                    <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                      <div style={{ fontSize:11, color:"var(--text3)" }}>{entry.date}</div>
                      <div style={{ fontSize:11, color:"var(--text3)", fontFamily:"'JetBrains Mono',monospace" }}>Vol: {entry.sets.reduce((a,s)=>a+s.weight*s.reps,0).toFixed(0)}kg</div>
                    </div>
                    <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
                      {entry.sets.map((s,j)=>{
                        const isTop = s.weight===Math.max(...entry.sets.map(x=>x.weight));
                        return (
                          <div key={j} style={{ padding:"4px 10px", borderRadius:20, background:isTop?"rgba(255,215,0,0.1)":"rgba(255,255,255,0.03)", border:`1px solid ${isTop?"rgba(255,215,0,0.3)":"var(--border2)"}`, fontSize:12, fontFamily:"'JetBrains Mono',monospace", color:isTop?"#ffd700":"var(--text2)", fontWeight:isTop?700:400 }}>
                            {s.weight}kg × {s.reps}
                          </div>
                        );
                      })}
                    </div>
                    {entry.note && <div style={{ fontSize:11, color:"var(--text3)", marginTop:5, fontStyle:"italic" }}>{entry.note}</div>}
                  </div>
                ))}
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FOOD LOG ITEM
// ─────────────────────────────────────────────────────────────────────────────
function FoodLogItem({ item, onDelete }) {
  const [open, setOpen] = useState(false);
  return (
    <Card style={{ marginBottom:10, overflow:"hidden" }}>
      <div onClick={()=>setOpen(o=>!o)} style={{ padding:"12px 14px", display:"flex", gap:12, alignItems:"center", cursor:"pointer" }}>
        {item.imageUrl && <img src={item.imageUrl} alt="" style={{ width:50, height:50, borderRadius:10, objectFit:"cover", flexShrink:0 }}/>}
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontWeight:700, fontSize:13, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{item.result.name}</div>
          <div style={{ fontSize:11, color:"#9090b8", marginTop:2 }}>{item.result.mealType} · {item.time}</div>
          <div style={{ display:"flex", gap:10, marginTop:3 }}>
            <span style={{ fontSize:12, color:"var(--brand)", fontWeight:700 }}>🔥 {item.result.calories}</span>
            <span style={{ fontSize:12, color:"#a78bfa" }}>💪 {item.result.protein}g</span>
          </div>
        </div>
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:6 }}>
          <span style={{ fontSize:10, color:"#8080a8" }}>{open?"▲":"▼"}</span>
          <button onClick={e=>{e.stopPropagation();onDelete();}} style={{ background:"none", border:"none", color:"#8080a8", cursor:"pointer", fontSize:13 }}>✕</button>
        </div>
      </div>
      {open && (
        <div style={{ padding:"0 14px 14px", borderTop:"1px solid #111", paddingTop:12 }}>
          <div style={{ display:"flex", justifyContent:"space-around", marginBottom:12 }}>
            {[{l:"Carbs",v:item.result.carbs,c:"#ffd700"},{l:"Fat",v:item.result.fat,c:"var(--brand2)"},{l:"Fiber",v:item.result.fiber,c:"#4ade80"},{l:"Sugar",v:item.result.sugar,c:"#f472b6"}].map(m=>(
              <div key={m.l} style={{ textAlign:"center" }}>
                <div style={{ fontSize:15, fontWeight:700, color:m.c }}>{m.v}g</div>
                <div style={{ fontSize:10, color:"#9090b8" }}>{m.l}</div>
              </div>
            ))}
          </div>
          <div style={{ marginBottom:6, display:"flex", justifyContent:"space-between" }}>
            <span style={{ fontSize:12, fontWeight:600 }}>Health Score</span>
            <span style={{ fontSize:12, fontWeight:700, color: item.result.healthScore>=70?"#4ade80":item.result.healthScore>=50?"#ffd700":"var(--brand)" }}>{item.result.healthScore}/100</span>
          </div>
          <ProgressBar value={item.result.healthScore} max={100} color={item.result.healthScore>=70?"#4ade80":item.result.healthScore>=50?"#ffd700":"var(--brand)"}/>
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SCAN ANIMATION OVERLAY
// ─────────────────────────────────────────────────────────────────────────────
function ScanOverlay() {
  return (
    <div style={{ position:"absolute", inset:0, borderRadius:16, overflow:"hidden", pointerEvents:"none" }}>
      <div style={{ position:"absolute", left:0, right:0, height:3, background:"linear-gradient(90deg,transparent,var(--brand),var(--brand2),transparent)", boxShadow:"0 0 20px var(--brand)", animation:"scanbeam 1.8s ease-in-out infinite" }}/>
      {[[{top:8,left:8},{borderTop:"2px solid var(--brand)",borderLeft:"2px solid var(--brand)"}],[{top:8,right:8},{borderTop:"2px solid var(--brand)",borderRight:"2px solid var(--brand)"}],[{bottom:8,left:8},{borderBottom:"2px solid var(--brand)",borderLeft:"2px solid var(--brand)"}],[{bottom:8,right:8},{borderBottom:"2px solid var(--brand)",borderRight:"2px solid var(--brand)"}]].map(([pos,border],i)=>(
        <div key={i} style={{ position:"absolute", width:20, height:20, ...pos, ...border, borderRadius:2 }}/>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE HOOK — persists to localStorage, works in all environments
// ─────────────────────────────────────────────────────────────────────────────
function useStorage(key, defaultValue) {
  const [value, setValue] = useState(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : defaultValue;
    } catch { return defaultValue; }
  });

  const setAndPersist = useCallback((updater) => {
    setValue(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      try { window.localStorage.setItem(key, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [key]);

  return [value, setAndPersist, true];
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function ApexFitUnified() {
  // ── Persistent state (saved to artifact storage) ──
  const [profile,          setProfile,          profileLoaded]          = useStorage("apex:profile", null);
  const [completedWorkouts,setCompletedWorkouts,cwLoaded]               = useStorage("apex:completedWorkouts", [1,3]);
  const [customWorkouts,   setCustomWorkouts,   customLoaded]           = useStorage("apex:customWorkouts", []);
  const [activeProgramId,  setActiveProgramId,  ]                       = useStorage("apex:activeProgramId", null); // user-selected or recommended
  const [progressionLog,   setProgressionLog,   ]                       = useStorage("apex:progressionLog", {});    // { "exerciseName": [{date, sets, reps, weight}] }
  // ── 🎮 RPG GAME STATE ──
  const [characterClass,   setCharacterClass,   ]                       = useStorage("apex:characterClass", null);  // null = needs to pick
  const [totalXp,          setTotalXp,          ]                       = useStorage("apex:totalXp", 0);
  const [charStats,        setCharStats,        ]                       = useStorage("apex:charStats", { STR:0, AGI:0, STA:0, WIS:0, VIT:0 });
  const [lastLevel,        setLastLevel,        ]                       = useStorage("apex:lastLevel", 1);          // for level-up detection
  const [recentGains,      setRecentGains      ]                        = useState(null);                            // { xp, stats, levelUp } shown after workout
  const [classPickerOpen,  setClassPickerOpen  ]                        = useState(false);
  // 🎮 Game state
  const [gameClass,    setGameClass,    ]                               = useStorage("apex:gameClass", null);          // class id string
  const [gameXp,       setGameXp,       ]                               = useStorage("apex:gameXp", 0);                // total XP earned
  const [gameStats,    setGameStats,    ]                               = useStorage("apex:gameStats", { STR:0, AGI:0, STA:0, WIS:0, VIT:0 });
  const [xpLog,        setXpLog,        ]                               = useStorage("apex:xpLog", []);                // [{date, source, xp}] for daily preview & history
  const [showLevelUp,  setShowLevelUp,  ]                               = useState(null);                              // {oldLvl, newLvl} or null
  const [loggedMeals,      setLoggedMeals,      mealsLoaded]            = useStorage("apex:loggedMeals", [1,2,4]);
  const [mealPortions,     setMealPortions,     ]                       = useStorage("apex:mealPortions", {}); // {mealId: multiplier}
  const [mealSwaps,        setMealSwaps,        ]                       = useStorage("apex:mealSwaps", {});    // {"dayIndex:Slot": mealId}
  const [mealDayOffset,    setMealDayOffset,    ]                       = useState(0);                          // 0=today, -1=yesterday, +1=tomorrow
  const [swapPickerOpen,   setSwapPickerOpen,   ]                       = useState(null);                       // slot name when swap picker open
  const [scannedLog,       setScannedLog,       scannedLoaded]          = useStorage("apex:scannedLog", []);
  const [quickLog,         setQuickLog,         quickLoaded]            = useStorage("apex:quickLog", []);
  const [streak,           setStreak,           streakLoaded]           = useStorage("apex:streak", 7);
  const [completedDays,    setCompletedDays,    daysLoaded]             = useStorage("apex:completedDays", [0,1,2,3,4]);
  const [weightHistory,    setWeightHistory,    weightLoaded]           = useStorage("apex:weightHistory", [84,83,82.5,82,81.5,81,80.5]);
  const [calHistory,       ,                    ]                       = useStorage("apex:calHistory", [1800,2100,1950,2200,1750,2050,1900]);
  const [wkHistory,        ,                    ]                       = useStorage("apex:wkHistory", [3,5,4,6,3,5,4]);

  // ── Wellness persistent state ──
  const [stressLog,        setStressLog,        ]  = useStorage("apex:stressLog",  []); // [{date,score}]
  const [sleepLog,         setSleepLog,         ]  = useStorage("apex:sleepLog",   []); // [{date,hours,quality}]
  const [moodLog,          setMoodLog,          ]  = useStorage("apex:moodLog",    []); // [{date,mood,note}]
  const [meditationLog,    setMeditationLog,    ]  = useStorage("apex:meditationLog", []); // [{date,duration}]

  // Loading gate — wait for all critical keys before rendering
  const appReady = profileLoaded && cwLoaded && mealsLoaded && quickLoaded && scannedLoaded;

  // ── Navigation ──
  const [tab, setTab] = useState("dashboard");

  // ── Workout state (session only) ──
  const [builderView, setBuilderView]             = useState("list");
  const [builderName, setBuilderName]             = useState("");
  const [builderType, setBuilderType]             = useState("Custom");
  const [builderExercises, setBuilderExercises]   = useState([]);
  const [builderDuration, setBuilderDuration]     = useState(30);
  const [activeWorkout, setActiveWorkout]         = useState(null);
  const [sessionLog,    setSessionLog]            = useState({}); // { exerciseName: [{ weight, reps }, ...] } for current session
  const [workoutTimer, setWorkoutTimer]           = useState(0);
  const [timerRunning, setTimerRunning]           = useState(false);

  // ── Nutrition state (session only) ──
  const [quickOpen, setQuickOpen]       = useState(false);
  const [quickName, setQuickName]       = useState("");
  const [quickCal, setQuickCal]         = useState("");
  const [quickPro, setQuickPro]         = useState("");
  const [quickCarbs, setQuickCarbs]     = useState("");
  const [quickFat, setQuickFat]         = useState("");
  const [scanImage, setScanImage]       = useState(null);
  const [scanImageData, setScanImageData] = useState(null);
  const [scanMime, setScanMime]         = useState("image/jpeg");
  const [scanning, setScanning]         = useState(false);
  const [scanResult, setScanResult]     = useState(null);
  const [scanError, setScanError]       = useState(null);
  const [scanLogged, setScanLogged]     = useState(false);
  const [scanSubTab, setScanSubTab]     = useState("camera");
  const [dragOver, setDragOver]         = useState(false);
  const fileRef = useRef(null);
  const camRef  = useRef(null);

  // ── Wearable / Google Fit ──
  const [gfitToken, setGfitToken]           = useState(null);
  const [gfitClientId, setGfitClientId]     = useState(GFIT_CLIENT_ID !== "YOUR_GOOGLE_CLIENT_ID_HERE" ? GFIT_CLIENT_ID : "");
  const [gfitConnecting, setGfitConnecting] = useState(false);
  const [gfitLoading, setGfitLoading]       = useState(false);
  const [gfitError, setGfitError]           = useState(null);
  const [gfitLastSync, setGfitLastSync]     = useState(null);
  const [gfitData, setGfitData]             = useState({ steps:0, calories:0, heartRate:0, distance:0, activeMinutes:0, weeklySteps:[], weeklyCalories:[], weeklyHR:[], hrStats:{current:0,resting:0,max:0,avg:0,zones:{peak:0,cardio:0,aerobic:0,fatburn:0,rest:0}} });
  const [gfitSleep, setGfitSleep]           = useState(null); // { lastNight:{date,hours}, entries:[{date,hours}] }

  // ── AI ──
  const [aiLoading, setAiLoading]           = useState(false);
  const [aiSuggestion, setAiSuggestion]     = useState(null);
  const [aiMessages, setAiMessages]         = useState([]);
  const [aiInput, setAiInput]               = useState("");
  const [chatOpen, setChatOpen]             = useState(false);
  const [builderLoading, setBuilderLoading] = useState(false);
  const [showResetHint, setShowResetHint]   = useState(false);
  const chatEnd = useRef(null);

  // ── Strength diary state ──
  const [strengthLog,    setStrengthLog,    ]  = useStorage("apex:strengthLog", []); // [{date, exercise, sets:[{reps,weight}]}]
  const [trainSubTab,    setTrainSubTab]        = useState("week"); // week | freestyle | programs | diary
  const [diaryExercise,  setDiaryExercise]      = useState("Bench Press");
  const [diarySets,      setDiarySets]          = useState([{reps:"",weight:""}]);
  const [diaryNote,      setDiaryNote]          = useState("");
  const [diaryView,      setDiaryView]          = useState("log"); // log | history

  // ── Wellness session state ──
  const [wellnessTab,      setWellnessTab]      = useState("overview"); // overview|breathe|meditate|stress|sleep|mood
  // Breathwork
  const [breathPattern,    setBreathPattern]    = useState(null);
  const [breathPhase,      setBreathPhase]      = useState("idle"); // idle|inhale|hold1|exhale|hold2
  const [breathCount,      setBreathCount]      = useState(0);
  const [breathTimer,      setBreathTimer]      = useState(0);
  const [breathRunning,    setBreathRunning]    = useState(false);
  const breathRef = useRef(null);
  // Meditation
  const [meditDuration,    setMeditDuration]    = useState(5);
  const [meditRunning,     setMeditRunning]     = useState(false);
  const [meditElapsed,     setMeditElapsed]     = useState(0);
  const meditRef = useRef(null);
  // Sleep logger
  const [sleepHours,       setSleepHours]       = useState(7);
  const [sleepQuality,     setSleepQuality]     = useState(3);
  // Mood
  const [todayMood,        setTodayMood]        = useState(null);
  const [moodNote,         setMoodNote]         = useState("");

  // ── Reset all data ──
  const resetAllData = () => {
    ["apex:profile","apex:completedWorkouts","apex:customWorkouts","apex:loggedMeals","apex:scannedLog","apex:quickLog","apex:streak","apex:completedDays","apex:weightHistory","apex:calHistory","apex:wkHistory"]
      .forEach(k => { try { window.localStorage.removeItem(k); } catch {} });
    window.location.reload();
  };

  // ── Loading screen ──
  if (!appReady) return (
    <div style={{ minHeight:"100vh", background:"#06060e", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16 }}>
      <div style={{ width:44, height:44, background:"linear-gradient(135deg,#ff3d2e,#e06800)", borderRadius:13, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 8px 24px rgba(255,61,46,0.4)" }}>
        <Zap size={22} color="#fff" strokeWidth={2.5}/>
      </div>
      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:22, letterSpacing:2, color:"#ece8e1", textTransform:"uppercase" }}>APEX FIT PRO</div>
      <div style={{ display:"flex", gap:6, marginTop:8 }}>
        {[0,1,2].map(i=>(
          <div key={i} style={{ width:8, height:8, borderRadius:"50%", background:"#ff3d2e", animation:`pulse 1.2s ${i*0.2}s ease-in-out infinite`, opacity:0.8 }}/>
        ))}
      </div>
      <style>{`@keyframes pulse{0%,100%{transform:scale(0.6);opacity:0.3}50%{transform:scale(1);opacity:1}}`}</style>
    </div>
  );

  // ── Effects ──
  useEffect(()=>{
    let iv; if(timerRunning) iv=setInterval(()=>setWorkoutTimer(t=>t+1),1000);
    return ()=>clearInterval(iv);
  },[timerRunning]);

  useEffect(()=>{ chatEnd.current?.scrollIntoView({behavior:"smooth"}); },[aiMessages]);

  // ── Breathwork tick ──
  useEffect(()=>{
    if (!breathRunning || !breathPattern) return;
    const phases = ["inhale","hold1","exhale","hold2"];
    let phaseIdx = 0; let tick = 0;
    const iv = setInterval(()=>{
      const dur = breathPattern.times[phaseIdx];
      if (dur===0) { phaseIdx=(phaseIdx+1)%4; tick=0; return; }
      tick++;
      setBreathTimer(tick);
      if (tick>=dur) {
        phaseIdx=(phaseIdx+1)%4; tick=0;
        setBreathPhase(phases[phaseIdx]);
        if (phaseIdx===0) setBreathCount(c=>c+1);
      }
    },1000);
    breathRef.current = iv;
    return ()=>clearInterval(iv);
  },[breathRunning, breathPattern]);

  // ── Meditation tick ──
  useEffect(()=>{
    if (!meditRunning) return;
    const today = new Date().toISOString().slice(0,10);
    const iv = setInterval(()=>{
      setMeditElapsed(e=>{
        if (e+1>=meditDuration*60) {
          clearInterval(iv); setMeditRunning(false);
          setMeditationLog(p=>[{date:today,duration:meditDuration},...p.slice(0,29)]);
          return 0;
        }
        return e+1;
      });
    },1000);
    meditRef.current = iv;
    return ()=>clearInterval(iv);
  },[meditRunning, meditDuration]);

  // ── Derived ──
  const allWorkouts = [...WORKOUTS, ...customWorkouts];

  const portionMult = (id) => mealPortions[id] ?? 1;
  const presetCal  = loggedMeals.reduce((a,id)=>a+Math.round((PRESET_MEALS.find(m=>m.id===id)?.calories||0)*portionMult(id)),0);
  const scannedCal = scannedLog.reduce((a,i)=>a+i.result.calories,0);
  const quickCals  = quickLog.reduce((a,i)=>a+i.calories,0);
  const totalCal   = presetCal + scannedCal + quickCals;

  const presetPro  = loggedMeals.reduce((a,id)=>a+Math.round((PRESET_MEALS.find(m=>m.id===id)?.protein||0)*portionMult(id)),0);
  const scannedPro = scannedLog.reduce((a,i)=>a+i.result.protein,0);
  const quickPros  = quickLog.reduce((a,i)=>a+(i.protein||0),0);
  const totalPro   = presetPro + scannedPro + quickPros;

  const totalCarbs = loggedMeals.reduce((a,id)=>a+Math.round((PRESET_MEALS.find(m=>m.id===id)?.carbs||0)*portionMult(id)),0) + scannedLog.reduce((a,i)=>a+i.result.carbs,0) + quickLog.reduce((a,i)=>a+(i.carbs||0),0);
  const totalFat   = loggedMeals.reduce((a,id)=>a+Math.round((PRESET_MEALS.find(m=>m.id===id)?.fat||0)*portionMult(id)),0)   + scannedLog.reduce((a,i)=>a+i.result.fat,0)   + quickLog.reduce((a,i)=>a+(i.fat||0),0);

  // ── Google Fit OAuth token from URL hash ──
  useEffect(()=>{
    const hash = window.location.hash;
    if (hash.includes("access_token")) {
      const params = new URLSearchParams(hash.replace("#",""));
      const t = params.get("access_token");
      if (t) { setGfitToken(t); window.history.replaceState({},document.title,window.location.pathname); setTab("watch"); }
    }
  },[]);

  const fetchGfitAll = useCallback(async (token)=>{
    setGfitLoading(true); setGfitError(null);
    try {
      const { startMs, endMs } = todayRange();
      const { startMs:wS, endMs:wE } = weekRange();
      const DAY = 86400000;
      const [st,cal,hr,dist,act,wSt,wCal,wHr,sleep,hrRaw] = await Promise.all([
        fetchFitData(token,"com.google.step_count.delta",startMs,endMs,null,MERGED_STEPS_SOURCE),
        fetchFitData(token,"com.google.calories.expended",startMs,endMs,null,MERGED_CALORIES_SOURCE),
        fetchFitData(token,"com.google.heart_rate.bpm",startMs,endMs),
        fetchFitData(token,"com.google.distance.delta",startMs,endMs),
        fetchFitData(token,"com.google.active_minutes",startMs,endMs),
        fetchFitData(token,"com.google.step_count.delta",wS,wE,DAY,MERGED_STEPS_SOURCE),
        fetchFitData(token,"com.google.calories.expended",wS,wE,DAY,MERGED_CALORIES_SOURCE),
        fetchFitData(token,"com.google.heart_rate.bpm",wS,wE,DAY),
        fetchSleepSessions(token, wS, wE),
        fetchHrSamples(token, startMs, endMs),
      ]);
      const hrStats = computeHrStats(hrRaw);
      setGfitData({ steps:extractInt(st), calories:Math.round(extractFloat(cal)), heartRate:hrStats.current||extractHR(hr), distance:Math.round(extractFloat(dist)/1000*10)/10, activeMinutes:extractInt(act), weeklySteps:extractDaily(wSt), weeklyCalories:extractDaily(wCal), weeklyHR:extractDaily(wHr).map(v=>Math.round(v)), hrStats });
      setGfitSleep(sleep);
      // Auto-populate sleepLog from Fit data
      if (sleep?.entries?.length) {
        setSleepLog(prev => {
          const existing = new Set(prev.map(e=>e.date));
          const newEntries = sleep.entries
            .filter(e => !existing.has(e.date))
            .map(e => ({ date:e.date, hours:e.hours, quality:null, source:"googlefit" }));
          return [...newEntries, ...prev].slice(0,60);
        });
      }
      setGfitLastSync(new Date());
    } catch(e) { setGfitError("Failed to fetch data. Check your permissions."); }
    setGfitLoading(false);
  },[]);

  useEffect(()=>{ if(gfitToken) fetchGfitAll(gfitToken); },[gfitToken, fetchGfitAll]);

  const connectGfit = () => {
    if (!gfitClientId.trim()) return;
    setGfitConnecting(true);
    sessionStorage.setItem("gfit_cid", gfitClientId);
    const p = new URLSearchParams({ client_id:gfitClientId.trim(), redirect_uri:window.location.origin+window.location.pathname, response_type:"token", scope:GFIT_SCOPES, prompt:"consent" });
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  };

  // ── AI helpers ──
  const getAISuggestion = async () => {
    setAiLoading(true); setAiSuggestion(null);
    const ctx = `User: ${profile?.name||"Athlete"}, Goal: ${profile?.goal}, Level: ${profile?.level}, Weight: ${profile?.weight}→${profile?.target}kg. Streak: ${streak}d. Workouts done: ${completedWorkouts.length}.`;
    const text = await callClaude([{role:"user",content:`${ctx}\nGive a personalized recommendation: 1) workout to do today & why, 2) one nutrition tip, 3) one motivational insight. Under 100 words total.`}]);
    setAiSuggestion(text); setAiLoading(false);
  };

  const sendChat = async () => {
    if (!aiInput.trim()) return;
    const msg = aiInput.trim(); setAiInput("");
    const msgs = [...aiMessages, {role:"user",content:msg}];
    setAiMessages([...msgs,{role:"assistant",content:"..."}]);
    const ctx = `Profile: name=${profile?.name}, goal=${profile?.goal}, level=${profile?.level}, weight=${profile?.weight}kg, target=${profile?.target}kg.`;
    const text = await callClaude([...msgs.slice(-8)], `You are APEX AI Coach. ${ctx} Be concise (under 80 words), motivational, actionable. No markdown.`);
    setAiMessages([...msgs,{role:"assistant",content:text}]);
  };

  const generateAIWorkout = async () => {
    setBuilderLoading(true);
    const text = await callClaude([{role:"user",content:`Create a workout for: goal=${profile?.goal||"fitness"}, level=${profile?.level||"intermediate"}. Return ONLY valid JSON: {"name":"...","type":"HIIT","duration":25,"calories":280,"exercises":["ex1","ex2","ex3","ex4","ex5"]}`}], "Return only valid JSON, no markdown.");
    try {
      const w = JSON.parse(text.replace(/```json|```/g,"").trim());
      setCustomWorkouts(p=>[...p,{...w,id:Date.now(),difficulty:"AI Generated",muscles:["Full Body"]}]);
      setBuilderView("list");
    } catch { alert("Couldn't parse AI workout, try again."); }
    setBuilderLoading(false);
  };

  const saveCustomWorkout = () => {
    if (!builderName || builderExercises.length < 2) return;
    setCustomWorkouts(p=>[...p,{id:Date.now(),name:builderName,type:builderType,duration:builderDuration,calories:Math.round(builderDuration*9),difficulty:"Custom",exercises:builderExercises,muscles:["Full Body"]}]);
    setBuilderName(""); setBuilderExercises([]); setBuilderView("list");
  };

  // ── Workout actions ──
  const startWorkout = w => {
    setActiveWorkout(w);
    setWorkoutTimer(0);
    setTimerRunning(true);
    // Initialize sessionLog with empty sets for each structured exercise
    if (w.structuredExercises) {
      const init = {};
      w.structuredExercises.forEach(ex=>{
        init[ex.name] = Array(ex.sets).fill(null).map(()=>({ weight:"", reps:"" }));
      });
      setSessionLog(init);
    } else {
      setSessionLog({});
    }
    setTab("active");
  };
  const finishWorkout = () => {
    if (activeWorkout && !completedWorkouts.includes(activeWorkout.id)) {
      setCompletedWorkouts(p=>[...p, activeWorkout.id]);
      // Update streak & today's completed day
      const todayIdx = new Date().getDay(); // 0=Sun … 6=Sat
      setCompletedDays(p => p.includes(todayIdx) ? p : [...p, todayIdx]);
      setStreak(s => s + (completedDays.includes(todayIdx) ? 0 : 1));
    }
    // Persist progression log entries (best set per exercise)
    let setsLogged = 0;
    if (Object.keys(sessionLog).length) {
      const dateStr = new Date().toISOString().slice(0,10);
      setProgressionLog(prev => {
        const next = {...prev};
        Object.entries(sessionLog).forEach(([exName, sets])=>{
          const validSets = sets.filter(s=>s && (s.reps || s.weight));
          if (!validSets.length) return;
          setsLogged += validSets.length;
          // Take the heaviest valid set as the session's "best"
          const best = validSets.reduce((b,s)=>{
            const sw = parseFloat(s.weight)||0;
            const bw = parseFloat(b.weight)||0;
            return sw > bw ? s : b;
          }, validSets[0]);
          const entry = { date:dateStr, weight:parseFloat(best.weight)||null, reps:parseFloat(best.reps)||null };
          next[exName] = [...(next[exName]||[]), entry];
        });
        return next;
      });
    }

    // 🎮 Award XP + stat gains
    const cls = CLASSES.find(c=>c.id===characterClass);
    const xpEarned = XP_REWARDS.WORKOUT_COMPLETE + setsLogged * XP_REWARDS.WORKOUT_SET_LOGGED;
    const statGains = activeWorkout ? workoutStatGain(activeWorkout, cls) : { STR:0,AGI:0,STA:0,WIS:0,VIT:0 };

    const prevLevel = levelFromXp(totalXp);
    const newTotal = totalXp + xpEarned;
    const newLevel = levelFromXp(newTotal);
    const didLevelUp = newLevel > prevLevel;

    setTotalXp(newTotal);
    setCharStats(prev=>({
      STR:(prev.STR||0)+statGains.STR,
      AGI:(prev.AGI||0)+statGains.AGI,
      STA:(prev.STA||0)+statGains.STA,
      WIS:(prev.WIS||0)+statGains.WIS,
      VIT:(prev.VIT||0)+statGains.VIT,
    }));
    if (didLevelUp) setLastLevel(newLevel);
    setRecentGains({ xp:xpEarned, stats:statGains, levelUp:didLevelUp?newLevel:null });

    setSessionLog({});
    setTimerRunning(false); setActiveWorkout(null); setTab("dashboard");
  };

  const addQuickMeal = () => {
    if (!quickName.trim() || !quickCal) return;
    setQuickLog(p=>[{ id:Date.now(), name:quickName.trim(), calories:parseInt(quickCal)||0, protein:parseInt(quickPro)||0, carbs:parseInt(quickCarbs)||0, fat:parseInt(quickFat)||0, time:new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}) }, ...p]);
    setQuickName(""); setQuickCal(""); setQuickPro(""); setQuickCarbs(""); setQuickFat(""); setQuickOpen(false);
  };

  // ── Food scan actions ──
  const processFile = useCallback(async file => {
    if (!file?.type.startsWith("image/")) return;
    const data = await b64(file);
    setScanImageData(data); setScanMime(file.type||"image/jpeg");
    setScanImage(URL.createObjectURL(file));
    setScanResult(null); setScanError(null); setScanLogged(false);
  },[]);

  const handleFileInput = e => { if(e.target.files[0]) processFile(e.target.files[0]); };

  const analyzeFood = async () => {
    if (!scanImageData) return;
    setScanning(true); setScanResult(null); setScanError(null);
    try {
      const text = await callClaude([{role:"user",content:[
        {type:"image",source:{type:"base64",media_type:scanMime,data:scanImageData}},
        {type:"text",text:FOOD_PROMPT}
      ]}], "You are a nutritionist AI. Return only valid JSON.");
      const parsed = JSON.parse(text.replace(/```json|```/g,"").trim());
      setScanResult(parsed);
    } catch { setScanError("Couldn't analyze image. Make sure it clearly shows food."); }
    setScanning(false);
  };

  const logScannedMeal = () => {
    if (!scanResult) return;
    setScannedLog(p=>[{id:Date.now(),imageUrl:scanImage,result:scanResult,time:new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}, ...p]);
    setScanLogged(true);
  };

  const resetScan = () => { setScanImage(null); setScanImageData(null); setScanResult(null); setScanError(null); setScanLogged(false); };

  // ─────────────────────────────────────────────────────────────────────────
  if (!profile) return <Onboarding onDone={p=>setProfile(p)} />;

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight:"100vh", background:"#06060e", color:"var(--text)", fontFamily:"'Syne',sans-serif", position:"relative", overflowX:"hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Syne:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap');
        :root{
          --brand:#ff3d2e; --brand2:#e06800; --accent:#00f5c4;
          --bg:#06060e; --bg1:#0d0d1a; --bg2:#111120; --bg3:#171728;
          --border:#1e1e32; --border2:#28283f;
          --text:#ece8e1; --text2:#a8a8c8; --text3:#7070a0;
          --glass:rgba(255,255,255,0.03);
          --grad:linear-gradient(135deg,#ff3d2e,#e06800);
        }
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:2px}
        ::-webkit-scrollbar-thumb{background:var(--brand);border-radius:2px}
        body{background:var(--bg)}

        /* GRAIN overlay */
        .grain::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:9999;opacity:0.028;
          background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
          background-repeat:repeat;background-size:128px}

        /* GLASS card */
        .glass{
          background:linear-gradient(135deg,rgba(255,255,255,0.04) 0%,rgba(255,255,255,0.01) 100%);
          border:1px solid var(--border2);
          border-radius:20px;
          backdrop-filter:blur(12px);
          -webkit-backdrop-filter:blur(12px);
          transition:border-color 0.25s,transform 0.2s;
        }
        .glass:hover{border-color:rgba(255,61,46,0.25)}
        .glass-hot{border-color:rgba(255,61,46,0.35)!important;box-shadow:0 0 40px rgba(255,61,46,0.08)}

        /* Typography */
        .display{font-family:'Barlow Condensed',sans-serif;font-weight:900;letter-spacing:-0.5px;line-height:0.95;text-transform:uppercase}
        .label{font-family:'Barlow Condensed',sans-serif;font-weight:700;letter-spacing:2px;text-transform:uppercase;font-size:10px;color:var(--text3)}
        .mono{font-family:'JetBrains Mono',monospace;font-weight:600}

        /* Inputs */
        input,select,textarea{
          background:var(--bg2);border:1px solid var(--border2);border-radius:12px;
          padding:11px 15px;color:var(--text);font-family:'Syne',sans-serif;font-size:14px;
          outline:none;width:100%;transition:border-color 0.2s,box-shadow 0.2s
        }
        input:focus,select:focus,textarea:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(255,61,46,0.12)}
        select option{background:var(--bg2)}

        /* Animations */
        @keyframes scanbeam{0%{top:0}50%{top:calc(100% - 3px)}100%{top:0}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
        @keyframes heartbeat{0%,100%{transform:scale(1)}14%{transform:scale(1.08)}28%{transform:scale(1)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
        @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
        @keyframes glow{0%,100%{box-shadow:0 0 20px rgba(255,61,46,0.2)}50%{box-shadow:0 0 40px rgba(255,61,46,0.45)}}
        @keyframes slideIn{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:translateX(0)}}

        .fadein{animation:fadeUp 0.4s cubic-bezier(0.16,1,0.3,1) forwards}
        .shimmer{background:linear-gradient(90deg,var(--bg2) 25%,var(--bg3) 50%,var(--bg2) 75%);background-size:200% 100%;animation:shimmer 1.8s infinite;border-radius:10px}

        /* Pill tags */
        .pill{display:inline-flex;align-items:center;padding:3px 10px;border-radius:100px;font-size:10px;font-weight:700;font-family:'Barlow Condensed',sans-serif;letter-spacing:0.5px;text-transform:uppercase}

        /* Nav active indicator */
        .nav-dot{width:4px;height:4px;border-radius:50%;background:var(--brand);margin-top:3px}
      `}</style>

      {/* Multi-layer background atmosphere */}
      <div className="grain" style={{ position:"fixed", inset:0, zIndex:0, pointerEvents:"none" }}>
        {/* Deep radial glow top */}
        <div style={{ position:"absolute", top:-120, left:"50%", transform:"translateX(-50%)", width:700, height:500, background:"radial-gradient(ellipse at 50% 0%,rgba(255,61,46,0.07) 0%,transparent 65%)", pointerEvents:"none" }}/>
        {/* Subtle bottom accent */}
        <div style={{ position:"absolute", bottom:0, left:"20%", width:300, height:200, background:"radial-gradient(ellipse,rgba(0,245,196,0.04) 0%,transparent 70%)", pointerEvents:"none" }}/>
        {/* Diagonal line texture */}
        <div style={{ position:"absolute", inset:0, backgroundImage:"repeating-linear-gradient(45deg,rgba(255,255,255,0.012) 0px,rgba(255,255,255,0.012) 1px,transparent 1px,transparent 28px)", pointerEvents:"none" }}/>
      </div>

      {/* ── HEADER ── */}
      <div style={{ position:"sticky", top:0, zIndex:200, background:"rgba(6,6,14,0.92)", backdropFilter:"blur(24px)", WebkitBackdropFilter:"blur(24px)", borderBottom:"1px solid rgba(255,255,255,0.05)", padding:"13px 20px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:11 }}>
          {/* Logo mark */}
          <div style={{ width:34, height:34, background:"var(--grad)", borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 4px 16px rgba(255,61,46,0.4)", flexShrink:0 }}><Zap size={18} color="#fff" strokeWidth={2.5}/></div>
          <div>
            <div className="display" style={{ fontSize:20, letterSpacing:1, color:"var(--text)", lineHeight:1 }}>APEX FIT</div>
            <div className="label" style={{ fontSize:8, color:"var(--text3)", letterSpacing:2 }}>PRO EDITION</div>
          </div>
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {/* Streak pill */}
          <div style={{ background:"rgba(255,130,0,0.12)", border:"1px solid rgba(255,130,0,0.25)", padding:"5px 12px", borderRadius:100, display:"flex", gap:5, alignItems:"center" }}>
            <Flame size={13} color="#e06800" strokeWidth={2.5}/>
            <span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, color:"#e06800", fontSize:14, letterSpacing:0.5 }}>{streak}</span>
            <span style={{ fontFamily:"'Syne',sans-serif", fontSize:10, color:"rgba(255,130,0,0.6)" }}>day streak</span>
          </div>
          {/* AI coach button */}
          <button onClick={()=>setChatOpen(true)} style={{ width:34, height:34, borderRadius:10, background:"linear-gradient(135deg,rgba(167,139,250,0.3),rgba(255,61,46,0.3))", border:"1px solid rgba(167,139,250,0.3)", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", backdropFilter:"blur(8px)" }}><Bot size={16} color="#c4b5fd" strokeWidth={2}/></button>
          {/* Avatar with reset on long-press */}
          <div style={{ position:"relative" }}>
            <div
              style={{ width:34, height:34, borderRadius:10, background:"var(--grad)", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Barlow Condensed',sans-serif", fontSize:16, fontWeight:900, boxShadow:"0 4px 12px rgba(255,61,46,0.3)", cursor:"pointer" }}
              title="Hold to reset data"
              onContextMenu={e=>{e.preventDefault(); if(window.confirm("Reset all data and start fresh?")) resetAllData();}}
              onClick={()=>setShowResetHint(h=>!h)}
            >{profile.name?.[0]?.toUpperCase()||"A"}</div>
            {showResetHint && (
              <div style={{ position:"absolute", top:42, right:0, background:"rgba(13,13,26,0.98)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:12, padding:"10px 14px", minWidth:180, zIndex:200, boxShadow:"0 8px 32px rgba(0,0,0,0.5)" }}>
                <div style={{ fontFamily:"'Syne',sans-serif", fontSize:11, color:"var(--text2)", marginBottom:8 }}>Signed in as <strong style={{color:"var(--text)"}}>{profile.name}</strong></div>
                <button onClick={()=>{ setProfile(null); setShowResetHint(false); }}
                  style={{ width:"100%", background:"rgba(167,139,250,0.10)", border:"1px solid rgba(167,139,250,0.25)", borderRadius:8, padding:"8px 10px", color:"#c4b5fd", fontFamily:"'Syne',sans-serif", fontSize:12, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", gap:6, marginBottom:6 }}>
                  <RotateCcw size={13} strokeWidth={2}/> View Onboarding
                </button>
                <button onClick={()=>{ if(window.confirm("Reset all data and start fresh?")) resetAllData(); setShowResetHint(false); }}
                  style={{ width:"100%", background:"rgba(255,61,46,0.12)", border:"1px solid rgba(255,61,46,0.3)", borderRadius:8, padding:"8px 10px", color:"var(--brand)", fontFamily:"'Syne',sans-serif", fontSize:12, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", gap:6 }}>
                  <Trash2 size={13} strokeWidth={2}/> Reset All Data
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── AI CHAT OVERLAY ── */}
      {chatOpen && (
        <div style={{ position:"fixed", inset:0, zIndex:300, background:"rgba(4,4,12,0.94)", backdropFilter:"blur(20px)", display:"flex", flexDirection:"column" }}>
          <div style={{ background:"rgba(13,13,26,0.98)", borderBottom:"1px solid rgba(255,255,255,0.06)", padding:"16px 20px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div style={{ display:"flex", alignItems:"center", gap:12 }}>
              <div style={{ width:40, height:40, borderRadius:12, background:"linear-gradient(135deg,rgba(167,139,250,0.35),rgba(255,61,46,0.35))", border:"1px solid rgba(167,139,250,0.3)", display:"flex", alignItems:"center", justifyContent:"center" }}><Bot size={20} color="#c4b5fd" strokeWidth={2}/></div>
              <div>
                <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:18, textTransform:"uppercase", letterSpacing:0.5, color:"var(--text)" }}>APEX AI Coach</div>
                <div style={{ fontFamily:"'Syne',sans-serif", fontSize:11, color:"var(--text3)" }}>Powered by Claude</div>
              </div>
            </div>
            <GhostBtn onClick={()=>setChatOpen(false)} style={{ padding:"6px 14px", fontSize:12 }}>✕ Close</GhostBtn>
          </div>
          <div style={{ flex:1, overflowY:"auto", padding:16, display:"flex", flexDirection:"column", gap:10 }}>
            {aiMessages.length===0 && (
              <div style={{ textAlign:"center", padding:"36px 16px" }}>
                <div style={{ display:"flex", justifyContent:"center", marginBottom:14 }}><Bot size={44} color="#a78bfa" strokeWidth={1.5}/></div>
                <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:22, textTransform:"uppercase", letterSpacing:0.5, marginBottom:6, color:"var(--text)" }}>Hi {profile.name}, I'm APEX.</div>
                <div style={{ fontFamily:"'Syne',sans-serif", fontSize:13, color:"var(--text2)", marginBottom:22, lineHeight:1.6 }}>Ask me anything about workouts, nutrition or recovery.</div>
                {["What workout should I do today?","How much protein do I need?","How can I break a plateau?"].map(q=>(
                  <button key={q} onClick={()=>setAiInput(q)} style={{ display:"block", width:"100%", background:"rgba(255,255,255,0.03)", border:"1px solid var(--border2)", borderRadius:12, padding:"11px 16px", color:"var(--text2)", fontFamily:"'Syne',sans-serif", fontSize:13, cursor:"pointer", textAlign:"left", marginBottom:8, transition:"all 0.2s" }}
                    onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--brand)";e.currentTarget.style.color="var(--text)"}}
                    onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border2)";e.currentTarget.style.color="var(--text2)"}}>
                    {q}
                  </button>
                ))}
              </div>
            )}
            {aiMessages.map((m,i)=>(
              <div key={i} style={{ display:"flex", justifyContent:m.role==="user"?"flex-end":"flex-start" }}>
                <div style={{ maxWidth:"82%", padding:"11px 16px", borderRadius:m.role==="user"?"16px 16px 4px 16px":"16px 16px 16px 4px", background:m.role==="user"?"var(--grad)":"rgba(255,255,255,0.04)", border:m.role==="user"?"none":"1px solid var(--border2)", fontFamily:"'Syne',sans-serif", fontSize:14, lineHeight:1.6, color:m.content==="..."?"var(--text3)":"var(--text)" }}>
                  {m.content==="..." ? <span style={{ animation:"pulse 1s infinite" }}>●●●</span> : m.content}
                </div>
              </div>
            ))}
            <div ref={chatEnd}/>
          </div>
          <div style={{ padding:14, borderTop:"1px solid rgba(255,255,255,0.05)", display:"flex", gap:10 }}>
            <input value={aiInput} onChange={e=>setAiInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendChat()} placeholder="Ask your AI coach…" style={{ flex:1 }}/>
            <PrimaryBtn onClick={sendChat} style={{ width:"auto", padding:"10px 20px", fontSize:14 }}>Send</PrimaryBtn>
          </div>
        </div>
      )}

      {/* ── MAIN CONTENT ── */}
      <div style={{ maxWidth:480, margin:"0 auto", padding:"18px 16px 100px", position:"relative", zIndex:1 }} className="fadein">

        {/* ════════════════════════════════ DASHBOARD ════════════════════════════════ */}
        {tab==="dashboard" && (
          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            {/* ── 🎮 CHARACTER SHEET ── */}
            {(()=>{
              const cls = CLASSES.find(c=>c.id===characterClass);
              const lvl = levelFromXp(totalXp);
              const tier = tierForLevel(lvl);
              const xp = xpProgress(totalXp);
              const accent = cls?.color || "var(--brand)";

              return (
                <>
                  {/* Hero card */}
                  <Card style={{ padding:18, background:`linear-gradient(135deg,${accent}14,transparent 70%)`, borderColor:`${accent}3a` }}>
                    <div style={{ display:"flex", alignItems:"center", gap:14 }}>
                      {/* Avatar */}
                      <div style={{ width:64, height:64, borderRadius:18, background:`linear-gradient(135deg,${accent},${accent}66)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:30, flexShrink:0, boxShadow:`0 8px 24px ${accent}50`, border:`2px solid ${accent}aa` }}>
                        {cls?.emoji || "🛡️"}
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:2, flexWrap:"wrap" }}>
                          <span style={{ fontSize:10, color:tier.color, fontWeight:800, textTransform:"uppercase", letterSpacing:0.6, padding:"2px 7px", borderRadius:20, background:`${tier.color}22`, border:`1px solid ${tier.color}55` }}>{tier.name}</span>
                          <span style={{ fontSize:11, color:"var(--text3)", fontWeight:600 }}>Lv {lvl}</span>
                        </div>
                        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:24, lineHeight:1.05, textTransform:"uppercase", letterSpacing:0.3 }}>{profile.name||"Hero"}</div>
                        <div style={{ fontSize:11, color:accent, fontWeight:700, marginTop:3, fontFamily:"'Syne',sans-serif" }}>
                          {cls ? `${cls.icon} ${cls.name} · ${cls.tagline}` : "Class not chosen"}
                        </div>
                      </div>
                      <button onClick={()=>setClassPickerOpen(true)}
                        style={{ padding:"6px 10px", background:cls?"transparent":"var(--grad)", border:cls?"1px solid var(--border2)":"none", borderRadius:8, color:cls?"var(--text3)":"#fff", fontSize:10, fontFamily:"'Syne',sans-serif", fontWeight:700, cursor:"pointer", flexShrink:0 }}>
                        {cls ? "Change" : "Pick Class"}
                      </button>
                    </div>

                    {/* XP bar */}
                    <div style={{ marginTop:14 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"var(--text3)", marginBottom:5, fontWeight:600 }}>
                        <span>XP</span>
                        <span>{xp.current} / {xp.needed}</span>
                      </div>
                      <div style={{ height:8, background:"var(--border)", borderRadius:100, overflow:"hidden", position:"relative" }}>
                        <div style={{ height:"100%", width:`${xp.pct}%`, background:`linear-gradient(90deg,${accent},${accent}cc)`, borderRadius:100, boxShadow:`0 0 12px ${accent}80`, transition:"width 0.6s ease-out" }}/>
                      </div>
                    </div>
                  </Card>

                  {/* Stat hexagon / radar */}
                  <Card style={{ padding:16 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                      <span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:16, textTransform:"uppercase", letterSpacing:0.5 }}>Stats</span>
                      <span style={{ fontSize:10, color:"var(--text3)", fontWeight:600 }}>Total: {Object.values(charStats).reduce((a,b)=>a+b,0)}</span>
                    </div>
                    {(()=>{
                      const stats = [
                        { key:"STR", label:"STR", icon:"💪", color:"#ff3d2e", desc:"Strength" },
                        { key:"AGI", label:"AGI", icon:"⚡", color:"#ffd700", desc:"Agility" },
                        { key:"STA", label:"STA", icon:"🫁", color:"#4ade80", desc:"Stamina" },
                        { key:"WIS", label:"WIS", icon:"🧠", color:"#a78bfa", desc:"Wisdom" },
                        { key:"VIT", label:"VIT", icon:"❤️", color:"#00e5ff", desc:"Vitality" },
                      ];
                      const max = Math.max(20, ...stats.map(s=>charStats[s.key]||0));
                      return (
                        <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
                          {stats.map(s=>{
                            const v = charStats[s.key]||0;
                            return (
                              <div key={s.key} style={{ display:"flex", alignItems:"center", gap:10 }}>
                                <div style={{ width:48, display:"flex", alignItems:"center", gap:5 }}>
                                  <span style={{ fontSize:14 }}>{s.icon}</span>
                                  <span style={{ fontSize:11, fontWeight:800, color:s.color, fontFamily:"'Syne',sans-serif", letterSpacing:0.5 }}>{s.label}</span>
                                </div>
                                <div style={{ flex:1, height:7, background:"var(--border)", borderRadius:100, overflow:"hidden" }}>
                                  <div style={{ height:"100%", width:`${Math.min(100,(v/max)*100)}%`, background:`linear-gradient(90deg,${s.color},${s.color}88)`, borderRadius:100, transition:"width 0.6s" }}/>
                                </div>
                                <span style={{ fontSize:13, fontWeight:700, color:s.color, fontFamily:"'Barlow Condensed',sans-serif", minWidth:24, textAlign:"right" }}>{v}</span>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </Card>
                </>
              );
            })()}

            <div style={{ paddingTop:4 }}>
              <div className="label" style={{ marginBottom:4 }}>Welcome back</div>
              <div className="display" style={{ fontSize:32, color:"var(--text)" }}>{profile.name} 💪</div>
            </div>

            {/* AI Card */}
            <Card style={{ padding:18 }} glow={!!aiSuggestion}>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
                <Bot size={16} color="#a78bfa" strokeWidth={2}/>
                <span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:16, textTransform:"uppercase", letterSpacing:0.5 }}>AI Coach</span>
                {aiLoading && <span style={{ fontSize:11, color:"#a78bfa", marginLeft:"auto", animation:"pulse 1s infinite" }}>Thinking…</span>}
              </div>
              {aiSuggestion
                ? <div style={{ fontSize:13, color:"#bbb", lineHeight:1.65, marginBottom:12 }}>{aiSuggestion}</div>
                : <div style={{ fontSize:13, color:"#7878a0", marginBottom:12 }}>Get a personalized recommendation based on your profile.</div>
              }
              <PrimaryBtn onClick={getAISuggestion} disabled={aiLoading} style={{ fontSize:13, padding:"10px" }}>
                {aiLoading ? "Generating…" : aiSuggestion ? "🔄 Refresh" : "✨ Get Today's Tip"}
              </PrimaryBtn>
            </Card>

            {/* Weekly streak */}
            <Card style={{ padding:16 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:12 }}>
                <span style={{ fontWeight:600, fontSize:13 }}>Weekly Progress</span>
                <span style={{ fontSize:11, color:"var(--brand2)" }}>{completedDays.length}/7 days</span>
              </div>
              <div style={{ display:"flex", gap:6 }}>
                {WEEK.map((d,i)=>(
                  <div key={d} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:5 }}>
                    <div style={{ width:"100%", aspectRatio:"1", borderRadius:7, background:completedDays.includes(i)?"linear-gradient(135deg,var(--brand),var(--brand2))":i===5?"var(--border)":"#0f0f1a", display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, color:completedDays.includes(i)?"#fff":"var(--border2)", fontWeight:700 }}>
                      {completedDays.includes(i)?"✓":i===5?"·":""}
                    </div>
                    <span style={{ fontSize:8, color:"var(--border2)", fontWeight:700 }}>{d}</span>
                  </div>
                ))}
              </div>
            </Card>

            {/* Quick stats */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              {[
                { label:"Cal Burned", value:completedWorkouts.reduce((a,id)=>a+(allWorkouts.find(w=>w.id===id)?.calories||0),0), unit:"kcal", Icon:Flame, color:"var(--brand)" },
                { label:"Workouts",   value:completedWorkouts.length+14, unit:"total", Icon:Dumbbell, color:"var(--brand2)" },
                { label:"Protein",    value:totalPro, unit:`/${150}g`, Icon:Layers, color:"#a78bfa" },
                { label:"To Goal",    value:Math.abs((profile.weight||84)-(profile.target||75)), unit:"kg left", Icon:Target, color:"#4ade80" },
              ].map(s=>(
                <Card key={s.label} style={{ padding:14 }}>
                  <div style={{ marginBottom:8 }}><s.Icon size={18} color={s.color} strokeWidth={2}/></div>
                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:26, color:s.color }}>{s.value}</div>
                  <div style={{ fontSize:10, color:"#7878a0" }}>{s.unit} · {s.label}</div>
                </Card>
              ))}
            </div>

            {/* Calories + macros */}
            <Card style={{ padding:16 }}>
              <div style={{ display:"flex", alignItems:"center", gap:16 }}>
                <DonutRing value={totalCal} max={2000} color="var(--brand)" size={84}/>
                <div style={{ flex:1 }}>
                  <div style={{ fontWeight:700, marginBottom:3, fontSize:14 }}>Daily Calories</div>
                  <div style={{ fontSize:12, color:"#7878a0", marginBottom:10 }}>{totalCal} / 2000 kcal</div>
                  {[{l:"Protein",v:totalPro,m:150,c:"#a78bfa"},{l:"Carbs",v:totalCarbs,m:200,c:"#ffd700"},{l:"Fat",v:totalFat,m:65,c:"var(--brand2)"}].map(m=>(
                    <div key={m.l} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                      <span style={{ width:38, fontSize:10, color:"#9090b8" }}>{m.l}</span>
                      <div style={{ flex:1 }}><ProgressBar value={m.v} max={m.m} color={m.c}/></div>
                      <span style={{ fontSize:10, color:m.c, fontWeight:700, width:30, textAlign:"right" }}>{m.v}g</span>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            {/* Goal progress */}
            <Card style={{ padding:16 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, fontWeight:700, marginBottom:12, fontSize:14 }}>
                <Target size={15} color="var(--brand2)" strokeWidth={2}/>
                Goal Progress · {{lose:"Lose Weight",muscle:"Build Muscle",endurance:"Endurance",flex:"Flexibility"}[profile.goal]||"Fitness"}
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:14 }}>
                <div style={{ textAlign:"center" }}>
                  <div style={{ fontSize:10, color:"#9090b8", marginBottom:1 }}>START</div>
                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:22, color:"var(--brand)" }}>{profile.weight||84}</div>
                </div>
                <div style={{ flex:1 }}>
                  <ProgressBar value={Math.abs((profile.weight||84)-80.5)} max={Math.abs((profile.weight||84)-(profile.target||75))||1}/>
                  <div style={{ fontSize:10, color:"#9090b8", textAlign:"center", marginTop:4 }}>
                    {pct(Math.abs((profile.weight||84)-80.5), Math.abs((profile.weight||84)-(profile.target||75))||1)}% complete
                  </div>
                </div>
                <div style={{ textAlign:"center" }}>
                  <div style={{ fontSize:10, color:"#9090b8", marginBottom:1 }}>TARGET</div>
                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:22, color:"#4ade80" }}>{profile.target||75}</div>
                </div>
              </div>
            </Card>
          </div>
        )}

        {/* ════════════════════════════════ TRAIN ════════════════════════════════ */}
        {tab==="train" && (
          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
              <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:30, letterSpacing:0.5, textTransform:"uppercase" }}>TRAIN</div>
              {trainSubTab==="freestyle" && (
                <PrimaryBtn onClick={()=>setBuilderView(v=>v==="list"?"build":"list")} style={{ width:"auto", padding:"8px 14px", fontSize:12 }}>
                  {builderView==="list" ? "+ BUILD" : "← Back"}
                </PrimaryBtn>
              )}
            </div>

            {/* Sub-nav */}
            <div style={{ display:"flex", gap:0, background:"#0d0d18", borderRadius:12, padding:4, overflowX:"auto" }}>
              {[
                {id:"week",     label:"📅 Week"},
                {id:"programs", label:"📋 Plans"},
                {id:"freestyle",label:"💪 Freestyle"},
                {id:"diary",    label:"📓 Diary"},
              ].map(t=>(
                <button key={t.id} onClick={()=>setTrainSubTab(t.id)}
                  style={{ flex:1, padding:"9px 4px", background:trainSubTab===t.id?"linear-gradient(135deg,var(--brand),var(--brand2))":"transparent", border:"none", color:trainSubTab===t.id?"#fff":"#555", fontFamily:"inherit", fontSize:12, fontWeight:700, borderRadius:9, cursor:"pointer", transition:"all 0.2s", whiteSpace:"nowrap" }}>
                  {t.label}
                </button>
              ))}
            </div>

            {/* ── THIS WEEK SUB-TAB ── */}
            {trainSubTab==="week" && (()=>{
              const program = PROGRAMS.find(p=>p.id===activeProgramId) || recommendProgram(profile);
              const today = new Date();
              const todayIdx = programDayForDate(today);
              const dayNames = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

              return (
                <>
                  {/* Program header */}
                  <Card style={{ padding:16, background:"linear-gradient(135deg,rgba(255,61,46,0.08),transparent 60%)", borderColor:"rgba(255,61,46,0.2)" }}>
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12 }}>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:10, color:"var(--text3)", fontWeight:700, textTransform:"uppercase", letterSpacing:0.8, marginBottom:3 }}>Current Program</div>
                        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:22, textTransform:"uppercase", lineHeight:1.1 }}>{program.emoji} {program.name}</div>
                        <div style={{ fontSize:11, color:"var(--text3)", marginTop:4 }}>{program.daysPerWeek} days · {program.level}</div>
                      </div>
                      <button onClick={()=>setTrainSubTab("programs")}
                        style={{ padding:"7px 12px", borderRadius:8, background:"var(--border)", border:"1px solid var(--border2)", color:"var(--text)", fontSize:11, fontFamily:"'Syne',sans-serif", fontWeight:600, cursor:"pointer", whiteSpace:"nowrap" }}>
                        Change
                      </button>
                    </div>
                  </Card>

                  {/* Weekly schedule */}
                  <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                    {program.schedule.map((workoutId, dayIdx)=>{
                      const isToday = dayIdx === todayIdx;
                      const workout = workoutId ? PROGRAM_WORKOUTS[workoutId] : null;
                      const isRest = !workout;
                      return (
                        <Card key={dayIdx}
                          onClick={workout ? ()=>startWorkout({...workout, id:workoutId, structuredExercises:workout.exercises, exercises:workout.exercises.map(e=>e.name)}) : undefined}
                          style={{ padding:14, cursor:workout?"pointer":"default", borderColor:isToday?"var(--brand)":"#1c1c2e", background:isToday?"rgba(255,61,46,0.04)":"var(--card)" }}>
                          <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                            <div style={{ width:40, textAlign:"center" }}>
                              <div style={{ fontSize:9, color:isToday?"var(--brand)":"var(--text3)", fontWeight:800, textTransform:"uppercase", letterSpacing:0.8 }}>{dayNames[dayIdx]}</div>
                              {isToday && <div style={{ fontSize:8, color:"var(--brand)", fontWeight:700, marginTop:2 }}>TODAY</div>}
                            </div>
                            <div style={{ flex:1, minWidth:0 }}>
                              {isRest ? (
                                <>
                                  <div style={{ fontSize:14, fontWeight:700, color:"var(--text2)" }}>💤 Rest Day</div>
                                  <div style={{ fontSize:11, color:"var(--text3)", marginTop:3, lineHeight:1.4 }}>{program.restActivity}</div>
                                </>
                              ) : (
                                <>
                                  <div style={{ fontSize:14, fontWeight:700, color:"var(--text)" }}>{workout.name}</div>
                                  <div style={{ display:"flex", gap:10, fontSize:11, color:"var(--text3)", marginTop:4, flexWrap:"wrap" }}>
                                    <span>⏱ {workout.duration}min</span>
                                    <span>🔥 {workout.calories}kcal</span>
                                    <span>💪 {workout.muscles.slice(0,2).join(", ")}</span>
                                  </div>
                                </>
                              )}
                            </div>
                            {workout && (
                              isToday ? (
                                <div style={{ padding:"7px 14px", borderRadius:100, background:"var(--grad)", color:"#fff", fontSize:11, fontWeight:700, fontFamily:"'Syne',sans-serif", whiteSpace:"nowrap", display:"flex", alignItems:"center", gap:4, boxShadow:"0 4px 14px rgba(255,61,46,0.4)" }}>
                                  Start <ChevronRight size={12} strokeWidth={2.5}/>
                                </div>
                              ) : (
                                <ChevronRight size={16} color="var(--text3)" strokeWidth={2}/>
                              )
                            )}
                          </div>
                        </Card>
                      );
                    })}
                  </div>

                  {/* Progressive overload hint */}
                  <Card style={{ padding:12, borderStyle:"dashed", borderColor:"var(--border2)", background:"transparent" }}>
                    <div style={{ fontSize:11, color:"var(--text3)", lineHeight:1.5, textAlign:"center" }}>
                      📈 Log your weights & reps in the workout — APEX will track your progression and suggest next session's load.
                    </div>
                  </Card>
                </>
              );
            })()}

            {/* ── PROGRAMS SUB-TAB ── */}
            {trainSubTab==="programs" && (
              <>
                <div style={{ fontSize:10, color:"#7878a0", fontWeight:700, textTransform:"uppercase", letterSpacing:1 }}>Choose Your Program</div>
                {PROGRAMS.map(p=>{
                  const sel = (activeProgramId||recommendProgram(profile).id) === p.id;
                  const recommended = !activeProgramId && recommendProgram(profile).id === p.id;
                  return (
                    <Card key={p.id} onClick={()=>{ setActiveProgramId(p.id); setTrainSubTab("week"); }}
                      style={{ padding:16, cursor:"pointer", borderColor:sel?"var(--brand)":"#1c1c2e", background:sel?"rgba(255,61,46,0.05)":"var(--card)" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:12 }}>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4, flexWrap:"wrap" }}>
                            <span style={{ fontSize:20 }}>{p.emoji}</span>
                            <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:18, textTransform:"uppercase", letterSpacing:0.3 }}>{p.name}</div>
                            {recommended && <span style={{ fontSize:9, padding:"2px 7px", borderRadius:20, background:"rgba(74,222,128,0.18)", color:"#4ade80", fontWeight:700, fontFamily:"'Syne',sans-serif" }}>RECOMMENDED</span>}
                          </div>
                          <div style={{ fontSize:12, color:"var(--text3)", marginBottom:8, lineHeight:1.45 }}>{p.description}</div>
                          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                            <span style={{ fontSize:10, padding:"2px 7px", borderRadius:20, background:"var(--border)", color:"#9898b8", fontWeight:600, fontFamily:"'Syne',sans-serif" }}>{p.daysPerWeek}d/week</span>
                            <span style={{ fontSize:10, padding:"2px 7px", borderRadius:20, background:"var(--border)", color:"#9898b8", fontWeight:600, fontFamily:"'Syne',sans-serif" }}>{p.level}</span>
                            <span style={{ fontSize:10, padding:"2px 7px", borderRadius:20, background:"var(--border)", color:"#9898b8", fontWeight:600, fontFamily:"'Syne',sans-serif" }}>{p.goal}</span>
                          </div>
                        </div>
                        {sel ? <CheckCircle2 size={20} color="var(--brand)" strokeWidth={2.5}/> : <ChevronRight size={18} color="var(--text3)"/>}
                      </div>
                    </Card>
                  );
                })}
              </>
            )}

            {/* ── FREESTYLE SUB-TAB (original workouts + custom builder) ── */}
            {trainSubTab==="freestyle" && (
              <>
                {builderView==="build" ? (
                  <div style={{ display:"flex", flexDirection:"column", gap:12 }} className="fadein">
                    <Card style={{ padding:18 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8, fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:18, textTransform:"uppercase", letterSpacing:0.5, marginBottom:14 }}><Settings size={16} strokeWidth={2}/> Workout Builder</div>
                      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                        <input value={builderName} onChange={e=>setBuilderName(e.target.value)} placeholder="Workout name…"/>
                        <select value={builderType} onChange={e=>setBuilderType(e.target.value)}>
                          {Object.keys(TC).map(t=><option key={t} value={t}>{t}</option>)}
                        </select>
                        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                          <span style={{ fontSize:12, color:"#9090b8", whiteSpace:"nowrap" }}>Duration</span>
                          <input type="range" min="10" max="90" value={builderDuration} onChange={e=>setBuilderDuration(Number(e.target.value))} style={{ flex:1, background:"none", accentColor:"var(--brand)", border:"none", padding:0 }}/>
                          <span style={{ fontSize:13, fontWeight:700, color:"var(--brand)", minWidth:34 }}>{builderDuration}m</span>
                        </div>
                      </div>
                    </Card>
                    <Card style={{ padding:18 }}>
                      <div style={{ fontWeight:600, fontSize:13, marginBottom:12 }}>Pick Exercises ({builderExercises.length} selected)</div>
                      <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                        {EXERCISES_LIB.map(ex=>{
                          const sel = builderExercises.includes(ex);
                          return (
                            <button key={ex} onClick={()=>setBuilderExercises(p=>sel?p.filter(e=>e!==ex):[...p,ex])}
                              style={{ padding:"5px 11px", borderRadius:20, border:`1px solid ${sel?"var(--brand)":"var(--border2)"}`, background:sel?"rgba(255,77,77,0.12)":"#0e0e18", color:sel?"var(--brand)":"#666", fontFamily:"inherit", fontSize:12, cursor:"pointer", transition:"all 0.15s" }}>
                              {ex}
                            </button>
                          );
                        })}
                      </div>
                    </Card>
                    <PrimaryBtn onClick={saveCustomWorkout} disabled={!builderName||builderExercises.length<2} style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}><CheckCircle2 size={15}/> Save Workout</PrimaryBtn>
                    <div style={{ textAlign:"center", color:"var(--text3)", fontSize:12 }}>— or —</div>
                    <PrimaryBtn onClick={generateAIWorkout} disabled={builderLoading} style={{ background:builderLoading?"var(--border)":"linear-gradient(135deg,#a78bfa,var(--brand))", color:builderLoading?"#444":"#fff", display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
                      {builderLoading ? <><RefreshCw size={15} style={{animation:"spin 0.8s linear infinite"}}/> Generating…</> : <><Sparkles size={15}/> Generate AI Workout</>}
                    </PrimaryBtn>
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize:11, color:"var(--text3)", lineHeight:1.5, marginBottom:4 }}>
                      Quick one-off workouts. Tap "+ BUILD" to create your own, or pick a preset below.
                    </div>
                    {customWorkouts.length>0 && (
                      <>
                        <div style={{ fontSize:10, color:"#7878a0", fontWeight:700, textTransform:"uppercase", letterSpacing:1 }}>Your Custom Workouts</div>
                        {customWorkouts.map(w=><WorkoutCard key={w.id} w={w} done={completedWorkouts.includes(w.id)} onStart={startWorkout}/>)}
                      </>
                    )}
                    <div style={{ fontSize:10, color:"#7878a0", fontWeight:700, textTransform:"uppercase", letterSpacing:1 }}>Preset Workouts</div>
                    {WORKOUTS.map(w=><WorkoutCard key={w.id} w={w} done={completedWorkouts.includes(w.id)} onStart={startWorkout}/>)}
                  </>
                )}
              </>
            )}

            {/* ── STRENGTH DIARY SUB-TAB ── */}
            {trainSubTab==="diary" && (
              <StrengthDiary strengthLog={strengthLog} setStrengthLog={setStrengthLog}/>
            )}
          </div>
        )}

        {/* ════════════════════════════════ ACTIVE WORKOUT ════════════════════════════════ */}
        {tab==="active" && activeWorkout && (
          <div style={{ display:"flex", flexDirection:"column", gap:18, alignItems:"center", textAlign:"center" }} className="fadein">
            <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:20, letterSpacing:2, color:"var(--brand)" }}>IN PROGRESS</div>
            <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:22 }}>{activeWorkout.name}</div>
            <Card style={{ padding:36, width:"100%", borderColor:"rgba(255,77,77,0.3)" }} glow>
              <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:68, letterSpacing:4, color:"var(--brand)", lineHeight:1, animation:"pulse 2s infinite" }}>{fmt(workoutTimer)}</div>
              <div style={{ fontSize:11, color:"#8080a8", marginTop:6 }}>elapsed · {activeWorkout.duration} min target</div>
              <div style={{ marginTop:18 }}>
                <GhostBtn onClick={()=>setTimerRunning(r=>!r)}>{timerRunning?"⏸ Pause":"▶ Resume"}</GhostBtn>
              </div>
            </Card>
            <Card style={{ padding:18, width:"100%", textAlign:"left" }}>
              <div style={{ fontWeight:700, marginBottom:12, fontSize:14, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <span>Exercises</span>
                {activeWorkout.structuredExercises && <span style={{ fontSize:10, color:"var(--text3)", fontWeight:600 }}>Tap inputs to log each set</span>}
              </div>

              {activeWorkout.structuredExercises ? (
                /* Structured exercise list with set logging */
                activeWorkout.structuredExercises.map((ex, exIdx)=>{
                  const history = progressionLog[ex.name];
                  const sug = suggestProgression(history, ex);
                  const setsLogged = sessionLog[ex.name] || [];
                  return (
                    <div key={ex.name} style={{ padding:"12px 0", borderBottom:exIdx<activeWorkout.structuredExercises.length-1?"1px solid #1c1c2e":"none" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8, gap:8 }}>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontWeight:700, fontSize:14, marginBottom:2 }}>{ex.name}</div>
                          <div style={{ fontSize:11, color:"var(--text3)" }}>{ex.sets} sets × {ex.reps} · rest {ex.restSec}s</div>
                        </div>
                        {sug && (
                          <div style={{ textAlign:"right", flexShrink:0 }}>
                            <div style={{ fontSize:9, color:"#4ade80", fontWeight:700, textTransform:"uppercase", letterSpacing:0.5 }}>Target</div>
                            <div style={{ fontSize:11, color:"#4ade80", fontWeight:700 }}>{sug.suggested}</div>
                            <div style={{ fontSize:9, color:"var(--text3)", marginTop:2 }}>last: {sug.last}</div>
                          </div>
                        )}
                      </div>
                      {/* Set inputs */}
                      <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
                        {setsLogged.map((set, setIdx)=>(
                          <div key={setIdx} style={{ display:"flex", alignItems:"center", gap:6, fontSize:12 }}>
                            <span style={{ width:34, color:"var(--text3)", fontWeight:600 }}>Set {setIdx+1}</span>
                            {ex.weighted && (
                              <>
                                <input type="number" placeholder="kg" inputMode="decimal" value={set.weight}
                                  onChange={e=>{
                                    const v = e.target.value;
                                    setSessionLog(prev=>{
                                      const next = {...prev};
                                      next[ex.name] = [...prev[ex.name]];
                                      next[ex.name][setIdx] = {...next[ex.name][setIdx], weight:v};
                                      return next;
                                    });
                                  }}
                                  style={{ width:56, padding:"6px 8px", fontSize:12, textAlign:"center" }}/>
                                <span style={{ color:"var(--text3)", fontSize:10 }}>kg ×</span>
                              </>
                            )}
                            <input type="number" placeholder={ex.weighted?"reps":"reps/secs"} inputMode="numeric" value={set.reps}
                              onChange={e=>{
                                const v = e.target.value;
                                setSessionLog(prev=>{
                                  const next = {...prev};
                                  next[ex.name] = [...prev[ex.name]];
                                  next[ex.name][setIdx] = {...next[ex.name][setIdx], reps:v};
                                  return next;
                                });
                              }}
                              style={{ width:60, padding:"6px 8px", fontSize:12, textAlign:"center" }}/>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })
              ) : (
                /* Legacy bodyweight checklist for non-structured workouts */
                activeWorkout.exercises.map((ex,i)=>(
                  <div key={ex} style={{ display:"flex", alignItems:"center", gap:12, padding:"8px 0", borderBottom:i<activeWorkout.exercises.length-1?"1px solid #111":"none" }}>
                    <div style={{ width:22, height:22, borderRadius:6, background:workoutTimer>i*180?"linear-gradient(var(--brand),var(--brand2))":"var(--border)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:700, flexShrink:0 }}>
                      {workoutTimer>i*180?"✓":i+1}
                    </div>
                    <span style={{ fontSize:14 }}>{ex}</span>
                  </div>
                ))
              )}
            </Card>
            <PrimaryBtn onClick={finishWorkout} style={{ fontSize:15, padding:14 }}>FINISH WORKOUT</PrimaryBtn>
          </div>
        )}

        {/* ════════════════════════════════ NUTRITION ════════════════════════════════ */}
        {tab==="nutrition" && (
          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:30, letterSpacing:0.5, textTransform:"uppercase" }}>MEAL PLAN</div>
            <Card style={{ padding:16, display:"flex", alignItems:"center", gap:14 }}>
              <DonutRing value={totalCal} max={2000} color="var(--brand)" size={72}/>
              <div style={{ flex:1 }}>
                {[{l:"Calories",v:totalCal,m:2000,c:"var(--brand)"},{l:"Protein",v:totalPro,m:150,c:"#a78bfa"}].map(m=>(
                  <div key={m.l} style={{ marginBottom:8 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, marginBottom:4 }}>
                      <span style={{ color:"#9090b8" }}>{m.l}</span>
                      <span style={{ color:m.c, fontWeight:700 }}>{m.v}/{m.m}</span>
                    </div>
                    <ProgressBar value={m.v} max={m.m} color={m.c}/>
                  </div>
                ))}
              </div>
            </Card>

            {/* Scan CTA */}
            <button onClick={()=>setTab("scan")} style={{ display:"flex", alignItems:"center", gap:12, padding:"14px 18px", background:"rgba(255,61,46,0.06)", border:"1px dashed rgba(255,61,46,0.3)", borderRadius:14, cursor:"pointer", width:"100%", textAlign:"left" }}>
              <div style={{ width:38, height:38, borderRadius:10, background:"linear-gradient(135deg,var(--brand),var(--brand2))", display:"flex", alignItems:"center", justifyContent:"center" }}><Camera size={18} color="#fff" strokeWidth={2}/></div>
              <div>
                <div style={{ fontWeight:700, color:"var(--text)", fontSize:14, fontFamily:"'Syne',sans-serif" }}>Scan a Meal</div>
                <div style={{ fontSize:12, color:"var(--text2)" }}>AI identifies calories & macros from a photo</div>
              </div>
              <div style={{ marginLeft:"auto", color:"var(--brand)" }}><ChevronRight size={18} strokeWidth={2}/></div>
            </button>

            {/* ── QUICK ADD ── */}
            <div>
              <button onClick={()=>setQuickOpen(o=>!o)}
                style={{ width:"100%", display:"flex", alignItems:"center", gap:12, padding:"14px 18px", background:"rgba(255,255,255,0.03)", border:`1px dashed ${quickOpen?"rgba(255,61,46,0.5)":"rgba(255,255,255,0.1)"}`, borderRadius:14, cursor:"pointer", textAlign:"left", transition:"all 0.2s" }}>
                <div style={{ width:38, height:38, borderRadius:10, background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.08)", display:"flex", alignItems:"center", justifyContent:"center" }}>
                  <Plus size={18} color="var(--text2)" strokeWidth={2}/>
                </div>
                <div>
                  <div style={{ fontWeight:700, color:"var(--text)", fontSize:14, fontFamily:"'Syne',sans-serif" }}>Quick Add</div>
                  <div style={{ fontSize:12, color:"var(--text2)" }}>Eating out? Log calories manually</div>
                </div>
                <div style={{ marginLeft:"auto", color:"var(--text3)", transition:"transform 0.2s", transform:quickOpen?"rotate(180deg)":"none" }}>
                  <ChevronDown size={18} strokeWidth={2}/>
                </div>
              </button>

              {quickOpen && (
                <Card style={{ padding:18, marginTop:8 }} className="fadein">
                  <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                    <input value={quickName} onChange={e=>setQuickName(e.target.value)} placeholder="Meal name (e.g. Chicken wrap, Latte…)"/>
                    {/* Calories — required, prominent */}
                    <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                      <div style={{ flex:1 }}>
                        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:11, letterSpacing:1, color:"var(--text3)", textTransform:"uppercase", marginBottom:5 }}>Calories <span style={{ color:"var(--brand)" }}>*</span></div>
                        <input type="number" value={quickCal} onChange={e=>setQuickCal(e.target.value)} placeholder="e.g. 450" style={{ textAlign:"center", fontFamily:"'Barlow Condensed',sans-serif", fontSize:22, fontWeight:900, color:"var(--brand)", letterSpacing:0.5 }}/>
                      </div>
                    </div>
                    {/* Optional macros row */}
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
                      {[{label:"Protein (g)", val:quickPro, set:setQuickPro, color:"#a78bfa"},{label:"Carbs (g)", val:quickCarbs, set:setQuickCarbs, color:"#ffd700"},{label:"Fat (g)", val:quickFat, set:setQuickFat, color:"var(--brand2)"}].map(f=>(
                        <div key={f.label}>
                          <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:10, letterSpacing:1, color:"var(--text3)", textTransform:"uppercase", marginBottom:5 }}>{f.label}</div>
                          <input type="number" value={f.val} onChange={e=>f.set(e.target.value)} placeholder="0" style={{ textAlign:"center", color:f.color, fontWeight:700 }}/>
                        </div>
                      ))}
                    </div>
                    <div style={{ display:"flex", gap:8 }}>
                      <PrimaryBtn onClick={addQuickMeal} disabled={!quickName.trim()||!quickCal} style={{ flex:1, padding:"11px", fontSize:14 }}>Add to Log</PrimaryBtn>
                      <GhostBtn onClick={()=>{setQuickOpen(false);setQuickName("");setQuickCal("");setQuickPro("");setQuickCarbs("");setQuickFat("");}} style={{ padding:"11px 16px" }}>Cancel</GhostBtn>
                    </div>
                  </div>
                </Card>
              )}
            </div>

            {/* Quick log entries */}
            {quickLog.length>0 && (
              <div>
                <div className="label" style={{ marginBottom:8 }}>Manually Added</div>
                {quickLog.map(item=>(
                  <Card key={item.id} style={{ padding:14, marginBottom:8 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                      <div>
                        <div style={{ fontWeight:700, fontSize:14, fontFamily:"'Syne',sans-serif", marginBottom:4 }}>{item.name}</div>
                        <div style={{ display:"flex", gap:12, fontSize:12, color:"var(--text2)", flexWrap:"wrap" }}>
                          <span style={{ color:"var(--brand)", fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", fontSize:14 }}>{item.calories} kcal</span>
                          {item.protein>0 && <span style={{ color:"#a78bfa" }}>{item.protein}g protein</span>}
                          {item.carbs>0   && <span style={{ color:"#ffd700" }}>{item.carbs}g carbs</span>}
                          {item.fat>0     && <span style={{ color:"var(--brand2)" }}>{item.fat}g fat</span>}
                        </div>
                        <div style={{ fontSize:11, color:"var(--text3)", marginTop:3 }}>{item.time}</div>
                      </div>
                      <button onClick={()=>setQuickLog(p=>p.filter(i=>i.id!==item.id))}
                        style={{ background:"none", border:"none", cursor:"pointer", color:"var(--text3)", padding:6, borderRadius:8, display:"flex", alignItems:"center", transition:"color 0.2s" }}
                        onMouseEnter={e=>e.currentTarget.style.color="var(--brand)"}
                        onMouseLeave={e=>e.currentTarget.style.color="var(--text3)"}>
                        <X size={15} strokeWidth={2}/>
                      </button>
                    </div>
                  </Card>
                ))}
              </div>
            )}

            {/* ── Day picker ─────────────────────────────────────── */}
            {(()=>{
              const today = new Date();
              const viewDate = new Date(today.getFullYear(), today.getMonth(), today.getDate()+mealDayOffset);
              const dayIdx = dayIndexFor(viewDate);
              const plan = getDayPlan(dayIdx, profile, mealSwaps);
              const dayLabel = mealDayOffset===0 ? "Today" : mealDayOffset===-1 ? "Yesterday" : mealDayOffset===1 ? "Tomorrow" : viewDate.toLocaleDateString(undefined,{weekday:"long"});
              const dateLabel = viewDate.toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"});

              return (
                <>
                  <Card style={{ padding:"10px 14px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                    <button onClick={()=>setMealDayOffset(d=>d-1)}
                      style={{ width:36, height:36, borderRadius:10, background:"var(--border)", border:"none", color:"var(--text)", fontSize:18, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>
                      ‹
                    </button>
                    <div style={{ textAlign:"center" }}>
                      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:22, textTransform:"uppercase", letterSpacing:0.5, lineHeight:1 }}>{dayLabel}</div>
                      <div style={{ fontSize:11, color:"var(--text3)", marginTop:3 }}>{dateLabel}</div>
                    </div>
                    <button onClick={()=>setMealDayOffset(d=>d+1)}
                      style={{ width:36, height:36, borderRadius:10, background:"var(--border)", border:"none", color:"var(--text)", fontSize:18, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>
                      ›
                    </button>
                  </Card>

                  {/* Plan list */}
                  {["Breakfast","Lunch","Dinner","Snack","Post-Workout"].map(slot=>{
                    const mealId = plan[slot];
                    const meal = PRESET_MEALS.find(m=>m.id===mealId);
                    if (!meal) return null;
                    const ok = mealDayOffset===0 && loggedMeals.includes(meal.id);
                    const mult = portionMult(meal.id);
                    const scaledCal  = Math.round(meal.calories * mult);
                    const scaledPro  = Math.round(meal.protein  * mult);
                    const scaledCarb = Math.round(meal.carbs    * mult);
                    const scaledFat  = Math.round(meal.fat      * mult);
                    const swapKey = `${dayIdx}:${slot}`;
                    const slotOptions = PRESET_MEALS.filter(m=>m.time===slot && m.id!==meal.id);
                    const swapping = swapPickerOpen===swapKey;

                    return (
                      <div key={slot}>
                        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:7 }}>
                          <div style={{ fontSize:10, color:"#8080a8", fontWeight:700, textTransform:"uppercase", letterSpacing:1 }}>{slot}</div>
                          <button onClick={()=>setSwapPickerOpen(swapping?null:swapKey)}
                            style={{ fontSize:10, color:swapping?"var(--brand)":"var(--text3)", fontWeight:700, background:"transparent", border:"none", cursor:"pointer", textTransform:"uppercase", letterSpacing:0.5, padding:"2px 8px", display:"flex", alignItems:"center", gap:4 }}>
                            <RotateCcw size={10} strokeWidth={2.5}/> {swapping?"Cancel":"Swap"}
                          </button>
                        </div>

                        {/* Swap picker - shows alternatives */}
                        {swapping && (
                          <Card style={{ padding:10, marginBottom:8, borderColor:"rgba(255,61,46,0.25)" }}>
                            <div style={{ fontSize:10, color:"var(--text3)", marginBottom:8, fontWeight:700, textTransform:"uppercase", letterSpacing:0.5 }}>Pick a replacement</div>
                            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                              {slotOptions.map(opt=>(
                                <button key={opt.id}
                                  onClick={()=>{ setMealSwaps(prev=>({...prev,[swapKey]:opt.id})); setSwapPickerOpen(null); }}
                                  style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 12px", borderRadius:10, background:"var(--border)", border:"1px solid var(--border2)", color:"var(--text)", textAlign:"left", cursor:"pointer", transition:"all 0.15s" }}>
                                  <div style={{ flex:1, minWidth:0 }}>
                                    <div style={{ fontWeight:600, fontSize:13, marginBottom:2 }}>{opt.name}</div>
                                    <div style={{ fontSize:10, color:"var(--text3)" }}>{opt.calories} kcal · {opt.protein}g protein</div>
                                  </div>
                                  <ChevronRight size={14} color="var(--text3)"/>
                                </button>
                              ))}
                              {mealSwaps[swapKey] && (
                                <button onClick={()=>{ setMealSwaps(prev=>{const n={...prev};delete n[swapKey];return n;}); setSwapPickerOpen(null); }}
                                  style={{ padding:"8px 12px", borderRadius:10, background:"transparent", border:"1px dashed var(--border2)", color:"var(--text3)", fontSize:11, cursor:"pointer", fontFamily:"'Syne',sans-serif", fontWeight:600 }}>
                                  Reset to default
                                </button>
                              )}
                            </div>
                          </Card>
                        )}

                        <Card style={{ padding:14, marginBottom:8, borderColor:ok?"rgba(74,222,128,0.25)":"#1c1c2e" }}>
                          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"start" }}>
                            <div style={{ flex:1 }}>
                              <div style={{ fontWeight:700, marginBottom:4 }}>{meal.name}</div>
                              {/* Portion selector */}
                              <div style={{ display:"flex", gap:4, marginBottom:8 }}>
                                {meal.portions.map((p,i)=>{
                                  const m = i===0?0.5:i===1?1:1.5;
                                  const sel = mult===m;
                                  return (
                                    <button key={i} onClick={()=>setMealPortions(prev=>({...prev,[meal.id]:m}))}
                                      style={{ padding:"3px 8px", borderRadius:20, border:`1px solid ${sel?"var(--brand)":"var(--border2)"}`, background:sel?"rgba(255,61,46,0.12)":"transparent", color:sel?"var(--brand)":"var(--text3)", fontSize:9, fontWeight:700, fontFamily:"'Syne',sans-serif", cursor:"pointer", transition:"all 0.2s", whiteSpace:"nowrap" }}>
                                      {p}
                                    </button>
                                  );
                                })}
                              </div>
                              {/* Scaled macros */}
                              <div style={{ display:"flex", gap:10, fontSize:12, color:"#9090b8", flexWrap:"wrap" }}>
                                <span>🔥 {scaledCal}</span>
                                <span>💪 {scaledPro}g</span>
                                <span>🌾 {scaledCarb}g</span>
                                <span>🥑 {scaledFat}g</span>
                              </div>
                              <div style={{ marginTop:6 }}>{meal.tags.map(t=><span key={t} style={{ display:"inline-block", padding:"2px 8px", borderRadius:20, fontSize:10, fontWeight:700, background:"var(--border)", color:"#9898b8", margin:2 }}>{t}</span>)}</div>
                            </div>
                            {mealDayOffset===0 && (
                              <button onClick={()=>setLoggedMeals(p=>ok?p.filter(m=>m!==meal.id):[...p,meal.id])}
                                style={{ width:30, height:30, borderRadius:8, border:"none", cursor:"pointer", flexShrink:0, marginLeft:10, background:ok?"rgba(74,222,128,0.2)":"var(--border)", color:ok?"#4ade80":"#555", fontSize:14, transition:"all 0.2s" }}>
                                {ok?"✓":"+"}
                              </button>
                            )}
                          </div>
                        </Card>
                      </div>
                    );
                  })}

                  {/* AI regenerate hint - placeholder for future */}
                  <Card style={{ padding:12, textAlign:"center", borderStyle:"dashed", borderColor:"var(--border2)", background:"transparent" }}>
                    <div style={{ fontSize:11, color:"var(--text3)", lineHeight:1.5 }}>
                      💡 Plan auto-rotates daily based on your goal. Tap <b>Swap</b> on any meal to change it.
                    </div>
                  </Card>
                </>
              );
            })()}
          </div>
        )}

        {/* ════════════════════════════════ FOOD SCAN ════════════════════════════════ */}
        {tab==="scan" && (
          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            {/* Sub-tabs */}
            <div style={{ display:"flex", gap:0, background:"#0d0d18", borderRadius:12, padding:4 }}>
              {[{id:"camera",label:"📷 Scan"},{id:"log",label:`📋 Log ${scannedLog.length>0?`(${scannedLog.length})`:""}` }].map(t=>(
                <button key={t.id} onClick={()=>setScanSubTab(t.id)}
                  style={{ flex:1, padding:"9px 0", background:scanSubTab===t.id?"linear-gradient(135deg,var(--brand),var(--brand2))":"transparent", border:"none", color:scanSubTab===t.id?"#fff":"#555", fontFamily:"inherit", fontSize:13, fontWeight:700, borderRadius:9, cursor:"pointer", transition:"all 0.2s" }}>
                  {t.label}
                </button>
              ))}
            </div>

            {scanSubTab==="camera" && (
              <>
                <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:24, letterSpacing:1 }}>AI FOOD SCANNER</div>

                {/* Drop zone / image */}
                {!scanImage ? (
                  <div onDragOver={e=>{e.preventDefault();setDragOver(true)}} onDragLeave={()=>setDragOver(false)} onDrop={e=>{e.preventDefault();setDragOver(false);if(e.dataTransfer.files[0])processFile(e.dataTransfer.files[0])}}
                    onClick={()=>fileRef.current?.click()}
                    style={{ border:`2px dashed ${dragOver?"var(--brand)":"var(--border2)"}`, borderRadius:18, padding:"44px 24px", textAlign:"center", cursor:"pointer", background:dragOver?"rgba(255,77,77,0.05)":"#0d0d18", transition:"all 0.2s" }}>
                    <div style={{ display:"flex", justifyContent:"center", marginBottom:14 }}><Camera size={52} color="var(--brand)" strokeWidth={1.2}/></div>
                    <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:20, letterSpacing:1, marginBottom:6 }}>SNAP YOUR MEAL</div>
                    <div style={{ fontSize:13, color:"#7878a0", marginBottom:22 }}>Drop a photo or tap to browse</div>
                    <div style={{ display:"flex", gap:10, justifyContent:"center" }}>
                      <PrimaryBtn onClick={e=>{e.stopPropagation();camRef.current?.click()}} style={{ width:"auto", padding:"9px 18px", fontSize:13 }}>📷 Camera</PrimaryBtn>
                      <GhostBtn onClick={e=>{e.stopPropagation();fileRef.current?.click()}}>🖼 Upload</GhostBtn>
                    </div>
                  </div>
                ) : (
                  <div style={{ position:"relative", borderRadius:16, overflow:"hidden" }}>
                    <img src={scanImage} alt="food" style={{ width:"100%", maxHeight:260, objectFit:"cover", display:"block", borderRadius:16 }}/>
                    {scanning && <ScanOverlay/>}
                    {!scanning && <button onClick={resetScan} style={{ position:"absolute", top:10, right:10, background:"rgba(0,0,0,0.7)", border:"1px solid #333", borderRadius:8, color:"#fff", padding:"5px 10px", cursor:"pointer", fontFamily:"inherit", fontSize:12 }}>✕</button>}
                  </div>
                )}

                <input ref={fileRef} type="file" accept="image/*" style={{ display:"none" }} onChange={handleFileInput}/>
                <input ref={camRef} type="file" accept="image/*" capture="environment" style={{ display:"none" }} onChange={handleFileInput}/>

                {scanning && (
                  <Card style={{ padding:14, display:"flex", alignItems:"center", gap:10 }}>
                    <div style={{ width:18, height:18, borderRadius:"50%", border:"2px solid var(--brand)", borderTopColor:"transparent", animation:"spin 0.8s linear infinite", flexShrink:0 }}/>
                    <span style={{ fontSize:13, color:"#888" }}>Analyzing with AI vision…</span>
                  </Card>
                )}

                {scanError && <Card style={{ padding:14, borderColor:"rgba(255,77,77,0.3)", background:"rgba(255,77,77,0.05)" }}><div style={{ fontSize:13, color:"#ff8888" }}>⚠️ {scanError}</div></Card>}

                {scanImage && !scanning && !scanResult && (
                  <PrimaryBtn onClick={analyzeFood}>ANALYZE NUTRITION</PrimaryBtn>
                )}

                {/* Result */}
                {scanResult && (
                  <div style={{ display:"flex", flexDirection:"column", gap:12 }} className="fadein">
                    <Card style={{ padding:18, borderColor:"rgba(255,77,77,0.25)" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"start", marginBottom:8 }}>
                        <div>
                          <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:22, lineHeight:1.1 }}>{scanResult.name}</div>
                          <div style={{ fontSize:11, color:"#9090b8", marginTop:2 }}>{scanResult.servingSize}</div>
                        </div>
                        <div style={{ textAlign:"center", flexShrink:0 }}>
                          <div style={{ fontSize:17, fontWeight:700, color:scanResult.confidence>80?"#4ade80":"#ffd700" }}>{scanResult.confidence}%</div>
                          <div style={{ fontSize:9, color:"#7878a0" }}>MATCH</div>
                        </div>
                      </div>
                      <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
                        <span style={{ padding:"2px 9px", borderRadius:20, background:"#1a1a28", fontSize:10, fontWeight:700, color:"#888" }}>{scanResult.mealType}</span>
                        {scanResult.dietTags?.map(t=><span key={t} style={{ padding:"2px 9px", borderRadius:20, background:"rgba(74,222,128,0.1)", border:"1px solid rgba(74,222,128,0.25)", fontSize:10, fontWeight:700, color:"#4ade80" }}>{t}</span>)}
                        {scanResult.warnings?.map(w=><span key={w} style={{ padding:"2px 9px", borderRadius:20, background:"rgba(255,77,77,0.1)", border:"1px solid rgba(255,77,77,0.25)", fontSize:10, fontWeight:700, color:"#ff8888" }}>⚠ {w}</span>)}
                      </div>
                    </Card>

                    {/* Calorie hero */}
                    <Card style={{ padding:16, textAlign:"center", background:"linear-gradient(135deg,#150a0a,#0f0a0a)", borderColor:"rgba(255,77,77,0.2)" }}>
                      <div style={{ fontSize:11, color:"#9090b8", letterSpacing:2, textTransform:"uppercase", marginBottom:2 }}>Total Calories</div>
                      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:64, letterSpacing:2, color:"var(--brand)", lineHeight:1, textShadow:"0 0 40px rgba(255,77,77,0.4)" }}>{scanResult.calories}</div>
                      <div style={{ fontSize:12, color:"#9090b8" }}>kcal · {scanResult.servingSize}</div>
                    </Card>

                    {/* Macros grid */}
                    <Card style={{ padding:16 }}>
                      <div style={{ fontWeight:700, fontSize:13, marginBottom:14 }}>Macronutrients</div>
                      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:8, textAlign:"center" }}>
                        {[{l:"Protein",v:scanResult.protein,c:"#a78bfa"},{l:"Carbs",v:scanResult.carbs,c:"#ffd700"},{l:"Fat",v:scanResult.fat,c:"var(--brand2)"},{l:"Fiber",v:scanResult.fiber,c:"#4ade80"}].map(m=>(
                          <div key={m.l}>
                            <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:22, color:m.c }}>{m.v}g</div>
                            <div style={{ fontSize:10, color:"#9090b8" }}>{m.l}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{ marginTop:12, display:"flex", flexDirection:"column", gap:6 }}>
                        {[{l:"Sodium",v:`${scanResult.sodium}mg`,c:"#00e5ff"},{l:"Sugar",v:`${scanResult.sugar}g`,c:"#f472b6"}].map(m=>(
                          <div key={m.l} style={{ display:"flex", justifyContent:"space-between", fontSize:12 }}>
                            <span style={{ color:"#9090b8" }}>{m.l}</span><span style={{ color:m.c, fontWeight:700 }}>{m.v}</span>
                          </div>
                        ))}
                      </div>
                    </Card>

                    {/* Health score */}
                    <Card style={{ padding:16 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                        <span style={{ fontWeight:700, fontSize:13 }}>Health Score</span>
                        <span style={{ fontSize:13, fontWeight:700, color:scanResult.healthScore>=70?"#4ade80":scanResult.healthScore>=50?"#ffd700":"var(--brand)" }}>{scanResult.healthScore}/100</span>
                      </div>
                      <ProgressBar value={scanResult.healthScore} max={100} color={scanResult.healthScore>=70?"#4ade80":scanResult.healthScore>=50?"#ffd700":"var(--brand)"} height={8}/>
                    </Card>

                    {/* Ingredients */}
                    {scanResult.ingredients?.length>0 && (
                      <Card style={{ padding:16 }}>
                        <div style={{ fontWeight:700, fontSize:13, marginBottom:10 }}>Detected Ingredients</div>
                        <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                          {scanResult.ingredients.map(i=><span key={i} style={{ padding:"4px 11px", borderRadius:20, background:"#1a1a28", border:"1px solid #252535", fontSize:12, color:"#888" }}>{i}</span>)}
                        </div>
                      </Card>
                    )}

                    {/* AI tip */}
                    {scanResult.tips && (
                      <Card style={{ padding:16, borderColor:"rgba(167,139,250,0.2)", background:"rgba(167,139,250,0.03)" }}>
                        <div style={{ display:"flex", gap:8, marginBottom:8 }}><Bot size={14} color="#a78bfa" strokeWidth={2}/><span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:15, textTransform:"uppercase", letterSpacing:0.5 }}>AI Insight</span></div>
                        <div style={{ fontSize:13, color:"#bbb", lineHeight:1.65 }}>{scanResult.tips}</div>
                        {scanResult.alternatives?.map((a,i)=><div key={i} style={{ display:"flex", gap:7, marginTop:6 }}><span style={{ color:"#4ade80", fontSize:12 }}>→</span><span style={{ fontSize:12, color:"#777" }}>{a}</span></div>)}
                      </Card>
                    )}

                    {/* Log button */}
                    {!scanLogged
                      ? <PrimaryBtn onClick={logScannedMeal}>LOG THIS MEAL</PrimaryBtn>
                      : (
                        <div style={{ display:"flex", gap:10 }}>
                          <div style={{ flex:1, background:"rgba(74,222,128,0.1)", border:"1px solid rgba(74,222,128,0.3)", borderRadius:12, padding:12, textAlign:"center", fontSize:14, fontWeight:700, color:"#4ade80" }}>✓ Logged!</div>
                          <GhostBtn onClick={resetScan}>Scan Another</GhostBtn>
                        </div>
                      )
                    }
                  </div>
                )}
              </>
            )}

            {scanSubTab==="log" && (
              <>
                <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:24, letterSpacing:1 }}>SCANNED MEALS</div>
                {scannedLog.length>0 && (
                  <Card style={{ padding:16 }}>
                    <div style={{ fontWeight:700, fontSize:13, marginBottom:12 }}>Today from Scans</div>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:8, textAlign:"center" }}>
                      {[{l:"Cal",v:scannedCal,c:"var(--brand)"},{l:"Protein",v:scannedPro+"g",c:"#a78bfa"},{l:"Items",v:scannedLog.length,c:"#4ade80"},{l:"Avg Score",v:Math.round(scannedLog.reduce((a,i)=>a+i.result.healthScore,0)/scannedLog.length),c:"#ffd700"}].map(s=>(
                        <div key={s.l}>
                          <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:20, color:s.c }}>{s.v}</div>
                          <div style={{ fontSize:9, color:"#7878a0" }}>{s.l}</div>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
                {scannedLog.length===0
                  ? <div style={{ textAlign:"center", padding:"44px 24px" }}>
                      <div style={{ display:"flex", justifyContent:"center", marginBottom:14 }}><Salad size={44} color="var(--text3)" strokeWidth={1.2}/></div>
                      <div style={{ fontWeight:700, marginBottom:6 }}>No scanned meals yet</div>
                      <div style={{ fontSize:13, color:"#7878a0", marginBottom:20 }}>Snap a photo to analyze your food</div>
                      <GhostBtn onClick={()=>setScanSubTab("camera")}>📷 Scan a Meal</GhostBtn>
                    </div>
                  : scannedLog.map(item=><FoodLogItem key={item.id} item={item} onDelete={()=>setScannedLog(p=>p.filter(i=>i.id!==item.id))}/>)
                }
              </>
            )}
          </div>
        )}

        {/* ════════════════════════════════ WATCH ════════════════════════════════ */}
        {tab==="watch" && (
          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            {!gfitToken ? (
              /* ── CONNECT SCREEN ── */
              <>
                <div>
                  <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
                    <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:30, letterSpacing:0.5, textTransform:"uppercase" }}>CONNECT WEARABLE</div>
                  </div>
                  <div style={{ display:"inline-flex", alignItems:"center", gap:6, background:"rgba(255,255,255,0.04)", border:"1px solid var(--border2)", borderRadius:100, padding:"4px 12px" }}>
                    <div style={{ width:6, height:6, borderRadius:"50%", background:"var(--text3)" }}/>
                    <span style={{ fontSize:11, color:"var(--text3)", fontFamily:"'Syne',sans-serif", fontWeight:600 }}>Not connected</span>
                  </div>
                </div>

                {/* Hero connection card */}
                <Card style={{ padding:24, borderColor:"rgba(255,61,46,0.25)", background:"linear-gradient(135deg,rgba(255,61,46,0.06),transparent 60%)" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:14, marginBottom:16 }}>
                    <div style={{ width:48, height:48, background:"var(--grad)", borderRadius:14, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 6px 20px rgba(255,61,46,0.35)", flexShrink:0 }}>
                      <Watch size={24} color="#fff" strokeWidth={2}/>
                    </div>
                    <div>
                      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:20, textTransform:"uppercase", letterSpacing:0.5, lineHeight:1 }}>Sync your watch</div>
                      <div style={{ fontSize:12, color:"var(--text3)", marginTop:4 }}>Works with any device that syncs to Google Fit</div>
                    </div>
                  </div>

                  <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:18 }}>
                    {[
                      { Icon:Heart, label:"Heart Rate", color:"var(--brand)" },
                      { Icon:Footprints, label:"Steps", color:"var(--brand2)" },
                      { Icon:BedDouble, label:"Sleep", color:"#a78bfa" },
                      { Icon:Flame, label:"Calories", color:"#ffd700" },
                      { Icon:Activity, label:"Distance", color:"#00e5ff" },
                      { Icon:Timer, label:"Active Min", color:"#4ade80" },
                    ].map(p=>(
                      <div key={p.label} style={{ display:"flex", alignItems:"center", gap:5, padding:"5px 10px", borderRadius:100, background:`${p.color}14`, border:`1px solid ${p.color}33` }}>
                        <p.Icon size={11} color={p.color} strokeWidth={2}/>
                        <span style={{ fontSize:11, color:p.color, fontFamily:"'Syne',sans-serif", fontWeight:600 }}>{p.label}</span>
                      </div>
                    ))}
                  </div>

                  <PrimaryBtn onClick={connectGfit} disabled={!gfitClientId.trim()||gfitConnecting} style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
                    {gfitConnecting ? "Redirecting to Google…" : (<><Watch size={15} strokeWidth={2.5}/> Connect Google Fit</>)}
                  </PrimaryBtn>

                  <div style={{ fontSize:11, color:"var(--text3)", textAlign:"center", marginTop:12, lineHeight:1.5 }}>
                    Google will ask for permission to share your fitness data.<br/>
                    <span style={{ color:"var(--text2)" }}>🔒 Data is fetched directly — never stored on our servers.</span>
                  </div>
                </Card>
              </>
            ) : (
              /* ── LIVE DATA SCREEN ── */
              <>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                  <div>
                    <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:30, letterSpacing:0.5, textTransform:"uppercase" }}>WEARABLE DATA</div>
                    {gfitLastSync && <div style={{ fontSize:10, color:"#7878a0" }}>Synced {gfitLastSync.toLocaleTimeString()}</div>}
                  </div>
                  <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:6, background:"rgba(74,222,128,0.1)", border:"1px solid rgba(74,222,128,0.3)", borderRadius:20, padding:"4px 12px" }}>
                      <div style={{ width:7, height:7, borderRadius:"50%", background:"#4ade80", animation:"pulse 2s infinite" }}/>
                      <span style={{ fontSize:11, color:"#4ade80", fontWeight:700 }}>LIVE</span>
                    </div>
                    <GhostBtn onClick={()=>fetchGfitAll(gfitToken)} style={{ padding:"6px 10px", fontSize:12 }}>↻</GhostBtn>
                    <GhostBtn onClick={()=>{setGfitToken(null);setGfitData({steps:0,calories:0,heartRate:0,distance:0,activeMinutes:0,weeklySteps:[],weeklyCalories:[],weeklyHR:[],hrStats:{current:0,resting:0,max:0,avg:0,zones:{peak:0,cardio:0,aerobic:0,fatburn:0,rest:0}}});}} style={{ padding:"6px 10px", fontSize:12 }}>✕</GhostBtn>
                  </div>
                </div>

                {gfitError && <Card style={{ padding:14, borderColor:"rgba(255,77,77,0.3)" }}><div style={{ fontSize:13, color:"#ff8888" }}>⚠️ {gfitError}</div></Card>}

                {/* Heart rate hero */}
                {(()=>{ const z=gfitData.heartRate>150?{l:"Peak",c:"var(--brand)"}:gfitData.heartRate>120?{l:"Cardio",c:"var(--brand2)"}:gfitData.heartRate>90?{l:"Aerobic",c:"#ffd700"}:gfitData.heartRate>60?{l:"Fat Burn",c:"#4ade80"}:{l:"Rest",c:"#00e5ff"}; return (
                  <Card style={{ padding:20, display:"flex", alignItems:"center", gap:18, borderColor:`${z.c}33` }}>
                    <HeartRateOrb bpm={gfitData.heartRate} loading={gfitLoading}/>
                    <div style={{ flex:1 }}>
                      <div style={{ fontWeight:700, fontSize:15, marginBottom:6 }}>Heart Rate</div>
                      <div style={{ display:"inline-flex", alignItems:"center", gap:6, background:`${z.c}22`, border:`1px solid ${z.c}44`, borderRadius:20, padding:"3px 12px", marginBottom:12 }}>
                        <div style={{ width:6, height:6, borderRadius:"50%", background:z.c, animation:"pulse 1s infinite" }}/>
                        <span style={{ fontSize:12, fontWeight:700, color:z.c }}>{z.l} Zone</span>
                      </div>
                      <div style={{ display:"flex", gap:16 }}>
                        {[{l:"Resting",v:gfitData.hrStats?.resting?`${gfitData.hrStats.resting} bpm`:"–"},{l:"Max",v:gfitData.hrStats?.max?`${gfitData.hrStats.max} bpm`:"–"}].map(s=>(
                          <div key={s.l}><div style={{ fontSize:10, color:"#9090b8" }}>{s.l}</div><div style={{ fontSize:14, fontWeight:700 }}>{gfitLoading?"–":s.v}</div></div>
                        ))}
                      </div>
                    </div>
                  </Card>
                ); })()}

                {/* Activity rings */}
                <Card style={{ padding:18 }}>
                  <div style={{ fontWeight:700, fontSize:14, marginBottom:16 }}>Today's Activity</div>
                  <div style={{ display:"flex", justifyContent:"space-around" }}>
                    <WearableRing value={gfitLoading?0:gfitData.steps}         max={10000} color="var(--brand)" label="Steps"   size={78}/>
                    <WearableRing value={gfitLoading?0:gfitData.calories}      max={600}   color="var(--brand2)" label="Calories" unit="kcal" size={78}/>
                    <WearableRing value={gfitLoading?0:gfitData.activeMinutes} max={60}    color="#4ade80" label="Active"   unit="min"  size={78}/>
                  </div>
                </Card>

                {/* Stats 2×2 */}
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                  {[{Icon:Footprints,label:"Steps",value:gfitLoading?"–":gfitData.steps.toLocaleString(),sub:"/10,000 goal",color:"var(--brand)"},{Icon:Flame,label:"Calories",value:gfitLoading?"–":`${gfitData.calories}`,sub:"kcal burned",color:"var(--brand2)"},{Icon:Activity,label:"Distance",value:gfitLoading?"–":`${gfitData.distance}`,sub:"km today",color:"#00e5ff"},{Icon:Timer,label:"Active",value:gfitLoading?"–":`${gfitData.activeMinutes}`,sub:"minutes",color:"#4ade80"}].map(s=>(
                    <Card key={s.label} style={{ padding:14 }}>
                      <div style={{ marginBottom:7 }}><s.Icon size={17} color={s.color} strokeWidth={2}/></div>
                      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:26, color:s.color }}>{s.value}</div>
                      <div style={{ fontSize:11, color:"var(--text3)" }}>{s.sub}·{s.label}</div>
                    </Card>
                  ))}
                </div>

                {/* Weekly step chart */}
                <Card style={{ padding:18 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:10 }}>
                    <span style={{ fontWeight:700, fontSize:14 }}>Steps This Week</span>
                    <span style={{ fontSize:12, color:"var(--brand)" }}>{gfitLoading?"–":(gfitData.weeklySteps.reduce((a,b)=>a+b,0)||0).toLocaleString()}</span>
                  </div>
                  <Sparkline data={gfitData.weeklySteps.length?gfitData.weeklySteps:[0,0]} color="var(--brand)"/>
                  <div style={{ display:"flex", justifyContent:"space-between", marginTop:4 }}>
                    {["M","T","W","T","F","S","S"].map((d,i)=><span key={i} style={{ fontSize:9, color:"#8080a8" }}>{d}</span>)}
                  </div>
                </Card>

                {/* Weekly calories chart */}
                <Card style={{ padding:18 }}>
                  <div style={{ fontWeight:700, fontSize:14, marginBottom:10 }}>Calories Burned / Day</div>
                  <Sparkline data={gfitData.weeklyCalories.length?gfitData.weeklyCalories:[0,0]} color="var(--brand2)"/>
                  <div style={{ display:"flex", justifyContent:"space-between", marginTop:4 }}>
                    {["M","T","W","T","F","S","S"].map((d,i)=><span key={i} style={{ fontSize:9, color:"#8080a8" }}>{d}</span>)}
                  </div>
                </Card>

                {/* HR zones */}
                <Card style={{ padding:18 }}>
                  <div style={{ fontWeight:700, fontSize:14, marginBottom:14 }}>Heart Rate Zones</div>
                  {[{l:"Peak",r:"150+",p:gfitData.hrStats?.zones?.peak||0,c:"var(--brand)"},{l:"Cardio",r:"120–150",p:gfitData.hrStats?.zones?.cardio||0,c:"var(--brand2)"},{l:"Aerobic",r:"90–120",p:gfitData.hrStats?.zones?.aerobic||0,c:"#ffd700"},{l:"Fat Burn",r:"60–90",p:gfitData.hrStats?.zones?.fatburn||0,c:"#4ade80"},{l:"Rest",r:"<60",p:gfitData.hrStats?.zones?.rest||0,c:"#00e5ff"}].map(z=>(
                    <div key={z.l} style={{ marginBottom:10 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                          <div style={{ width:8, height:8, borderRadius:"50%", background:z.c }}/>
                          <span style={{ fontSize:13, fontWeight:500 }}>{z.l}</span>
                          <span style={{ fontSize:11, color:"#9090b8" }}>{z.r} bpm</span>
                        </div>
                        <span style={{ fontSize:12, color:z.c, fontWeight:700 }}>{z.p}%</span>
                      </div>
                      <ProgressBar value={z.p} max={100} color={z.c} height={5}/>
                    </div>
                  ))}
                </Card>
              </>
            )}
          </div>
        )}

        {/* ════════════════════════════════ PROGRESS ════════════════════════════════ */}
        {tab==="progress" && (
          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:30, letterSpacing:0.5, textTransform:"uppercase" }}>MY PROGRESS</div>

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
              {[
                {label:"Streak",  value:streak,                       unit:"days",  Icon:Flame,    color:"var(--brand2)"},
                {label:"Workouts",value:completedWorkouts.length+14,   unit:"total", Icon:Dumbbell, color:"var(--brand)"},
                {label:"Lost",    value:`${(profile.weight||84)-177}`, unit:"kg",   Icon:TrendingDown, color:"#4ade80"},
              ].map(s=>(
                <Card key={s.label} style={{ padding:12, textAlign:"center" }}>
                  <div style={{ display:"flex", justifyContent:"center", marginBottom:4 }}><s.Icon size={17} color={s.color} strokeWidth={2}/></div>
                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:24, color:s.color, marginTop:2 }}>{s.value}</div>
                  <div style={{ fontSize:9, color:"var(--text3)", marginTop:1 }}>{s.unit}</div>
                </Card>
              ))}
            </div>

            <Card style={{ padding:16 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:10 }}>
                <span style={{ fontWeight:700, fontSize:14 }}>Weight (lbs)</span>
                <span style={{ fontSize:12, color:"#4ade80" }}>↓ {weightHistory[0]-weightHistory[weightHistory.length-1]} kg</span>
              </div>
              <Sparkline data={weightHistory} color="var(--brand)"/>
              <div style={{ display:"flex", justifyContent:"space-between", marginTop:4 }}>
                {WEEK.map(d=><span key={d} style={{ fontSize:9, color:"#8080a8" }}>{d}</span>)}
              </div>
            </Card>

            <Card style={{ padding:16 }}>
              <div style={{ fontWeight:700, fontSize:14, marginBottom:12 }}>Daily Calories</div>
              <BarChart data={calHistory} labels={WEEK} color="var(--brand2)"/>
            </Card>

            <Card style={{ padding:16 }}>
              <div style={{ fontWeight:700, fontSize:14, marginBottom:12 }}>Workout Sessions / Week</div>
              <BarChart data={wkHistory} labels={["W1","W2","W3","W4","W5","W6","W7"]} color="#a78bfa"/>
            </Card>

            <Card style={{ padding:16 }}>
              <div style={{ fontWeight:700, fontSize:14, marginBottom:14 }}>Body Measurements</div>
              {[
                {label:"Weight",current:"80.5 kg",start:`${profile.weight||84} kg`,progress:85,color:"var(--brand)"},
                {label:"Body Fat",current:"18%",start:"22%",progress:72,color:"#ffd700"},
                {label:"Muscle Mass",current:"66 kg",start:"63 kg",progress:60,color:"#a78bfa"},
                {label:"BMI",current:"24.1",start:"25.8",progress:78,color:"#00e5ff"},
              ].map(m=>(
                <div key={m.label} style={{ marginBottom:14 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:5 }}>
                    <span style={{ fontSize:13, fontWeight:500 }}>{m.label}</span>
                    <div style={{ fontSize:12, color:"#9090b8" }}><span style={{ color:"#fff", fontWeight:700 }}>{m.current}</span> from {m.start}</div>
                  </div>
                  <ProgressBar value={m.progress} max={100} color={m.color}/>
                </div>
              ))}
            </Card>

            <Card style={{ padding:16 }}>
              <div style={{ fontWeight:700, fontSize:14, marginBottom:14 }}>Weekly Targets</div>
              <div style={{ display:"flex", justifyContent:"space-around" }}>
                <DonutRing value={completedWorkouts.length} max={parseInt(profile.days||4)} color="var(--brand)" label="Workouts"/>
                <DonutRing value={totalCal} max={2000} color="#ffd700" label="Calories"/>
                <DonutRing value={totalPro} max={150} color="#a78bfa" label="Protein"/>
              </div>
            </Card>

            <Card style={{ padding:16 }}>
              <div style={{ fontWeight:700, fontSize:14, marginBottom:14 }}>Achievements</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                {[
                  {name:"First Workout", Icon:Trophy,      color:"#ffd700",       unlocked:true},
                  {name:"7-Day Streak",  Icon:Flame,       color:"var(--brand2)", unlocked:true},
                  {name:"5 kg Down",    Icon:TrendingDown,color:"#4ade80",        unlocked:true},
                  {name:"Food Scanner",  Icon:Camera,      color:"#00e5ff",        unlocked:scannedLog.length>0},
                  {name:"AI Builder",    Icon:Cpu,         color:"#a78bfa",        unlocked:customWorkouts.length>0},
                  {name:"Iron Will",     Icon:Shield,      color:"var(--brand)",   unlocked:completedWorkouts.length+14>=25},
                ].map(a=>(
                  <div key={a.name} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 12px", borderRadius:12, background:a.unlocked?"rgba(255,61,46,0.06)":"rgba(255,255,255,0.02)", border:`1px solid ${a.unlocked?"rgba(255,61,46,0.2)":"rgba(255,255,255,0.04)"}`, opacity:a.unlocked?1:0.35, transition:"all 0.3s" }}>
                    <a.Icon size={16} color={a.unlocked?a.color:"var(--text3)"} strokeWidth={2}/>
                    <span style={{ fontSize:12, fontWeight:600, color:a.unlocked?"var(--text)":"var(--text3)", fontFamily:"'Syne',sans-serif" }}>{a.name}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}
        {/* ════════════════════════════════ WELLNESS ════════════════════════════════ */}
        {tab==="wellness" && (()=>{
          const today = new Date().toISOString().slice(0,10);
          const BREATH_PATTERNS = [
            { id:"box",    name:"Box Breathing",   desc:"Calm & focus", color:"#00e5ff", times:[4,4,4,4],  labels:["Inhale","Hold","Exhale","Hold"] },
            { id:"478",    name:"4-7-8 Relaxing",  desc:"Sleep & anxiety", color:"#a78bfa", times:[4,7,8,0],  labels:["Inhale","Hold","Exhale",""] },
            { id:"wim",    name:"Power Breath",    desc:"Energy & clarity", color:"#ff3d2e", times:[2,0,2,0],  labels:["Inhale","","Exhale",""] },
            { id:"calm",   name:"Calm Breath",     desc:"Stress relief", color:"#4ade80", times:[5,0,6,0],  labels:["Inhale","","Exhale",""] },
          ];
          const MOOD_OPTIONS = [
            { v:"great",   label:"Great",    Icon:Sun,      color:"#ffd700" },
            { v:"good",    label:"Good",     Icon:Smile,    color:"#4ade80" },
            { v:"okay",    label:"Okay",     Icon:Meh,      color:"#e06800" },
            { v:"low",     label:"Low",      Icon:CloudRain,color:"#a78bfa" },
            { v:"rough",   label:"Rough",    Icon:Frown,    color:"#ff3d2e" },
          ];

          // Recovery score calc
          const lastSleep   = gfitToken && gfitSleep?.lastNight
            ? { hours: gfitSleep.lastNight.hours, quality: sleepLog.find(s=>s.date===gfitSleep.lastNight.date)?.quality || 3 }
            : sleepLog[sleepLog.length-1];
          const lastStress  = stressLog[stressLog.length-1];
          const lastMood    = moodLog[moodLog.length-1];
          const sleepScore  = lastSleep  ? Math.min(100, Math.round((lastSleep.hours/8)*50 + (lastSleep.quality/5)*50)) : 50;
          const stressScore = lastStress ? Math.round((1 - (lastStress.score-1)/4)*100) : 70;
          const moodScore   = lastMood   ? ({great:100,good:80,okay:60,low:40,rough:20}[lastMood.mood]||60) : 60;
          const workoutLoad = Math.min(100, completedWorkouts.length * 8);
          const recoveryScore = Math.round((sleepScore*0.4 + stressScore*0.3 + moodScore*0.2 + (100-workoutLoad)*0.1));
          const recoveryLabel = recoveryScore>=80?"Optimal":recoveryScore>=60?"Good":recoveryScore>=40?"Moderate":"Rest Day";
          const recoveryColor = recoveryScore>=80?"#4ade80":recoveryScore>=60?"#e06800":recoveryScore>=40?"#a78bfa":"#ff3d2e";

          // Breathwork engine
          const startBreath = (pattern) => {
            setBreathPattern(pattern); setBreathCount(0); setBreathTimer(0);
            setBreathPhase("inhale"); setBreathRunning(true);
          };
          const stopBreath = () => { setBreathRunning(false); setBreathPhase("idle"); setBreathPattern(null); clearInterval(breathRef.current); };

          const breathScale = breathPhase==="inhale"?1.3:breathPhase==="hold1"?1.3:breathPhase==="exhale"?0.75:0.75;
          const breathLabel = breathPattern ? breathPattern.labels[["inhale","hold1","exhale","hold2"].indexOf(breathPhase)] : "";

          const WTABS = [
            {id:"overview",label:"Overview", Icon:Stars},
            {id:"breathe", label:"Breathe",  Icon:Wind},
            {id:"meditate",label:"Meditate", Icon:Brain},
            {id:"stress",  label:"Stress",   Icon:AlertCircle},
            {id:"sleep",   label:"Sleep",    Icon:BedDouble},
            {id:"mood",    label:"Mood",     Icon:Smile},
          ];

          return (
            <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
              {/* Header */}
              <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:30, letterSpacing:0.5, textTransform:"uppercase" }}>WELLNESS</div>

              {/* Sub-nav */}
              <div style={{ display:"flex", gap:6, overflowX:"auto", paddingBottom:2 }}>
                {WTABS.map(({id,label,Icon})=>(
                  <button key={id} onClick={()=>setWellnessTab(id)}
                    style={{ display:"flex", alignItems:"center", gap:5, padding:"7px 13px", borderRadius:100, border:`1px solid ${wellnessTab===id?"var(--brand)":"var(--border2)"}`, background:wellnessTab===id?"rgba(255,61,46,0.12)":"transparent", color:wellnessTab===id?"var(--brand)":"var(--text3)", fontFamily:"'Syne',sans-serif", fontSize:11, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap", transition:"all 0.2s", flexShrink:0 }}>
                    <Icon size={12} strokeWidth={2}/>{label}
                  </button>
                ))}
              </div>

              {/* ── OVERVIEW ── */}
              {wellnessTab==="overview" && (
                <div style={{ display:"flex", flexDirection:"column", gap:12 }} className="fadein">
                  {/* Recovery score hero */}
                  <Card style={{ padding:20, background:`linear-gradient(135deg,${recoveryColor}18,transparent)`, border:`1px solid ${recoveryColor}44` }}>
                    <div style={{ display:"flex", alignItems:"center", gap:16 }}>
                      <DonutRing value={recoveryScore} max={100} color={recoveryColor} size={88}/>
                      <div>
                        <div className="label" style={{ marginBottom:4 }}>Recovery Score</div>
                        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:42, color:recoveryColor, lineHeight:1 }}>{recoveryScore}</div>
                        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, fontSize:18, color:recoveryColor, opacity:0.8 }}>{recoveryLabel}</div>
                        <div style={{ fontSize:11, color:"var(--text3)", marginTop:4 }}>Based on sleep, stress & mood</div>
                      </div>
                    </div>
                  </Card>

                  {/* 4 quick stats */}
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                    {[
                      { label:"Sleep",   val:lastSleep?`${lastSleep.hours}h`:"–",   Icon:BedDouble,   color:"#a78bfa" },
                      { label:"Stress",  val:lastStress?`${lastStress.score}/5`:"–", Icon:AlertCircle, color:"#ff3d2e" },
                      { label:"Mood",    val:lastMood?lastMood.mood:"–",             Icon:Smile,       color:"#4ade80" },
                      { label:"Meditated",val:meditationLog.length?`${meditationLog.length}x`:"–",    Icon:Brain, color:"#00e5ff" },
                    ].map(s=>(
                      <Card key={s.label} style={{ padding:14 }}>
                        <s.Icon size={16} color={s.color} strokeWidth={2} style={{ marginBottom:6 }}/>
                        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:22, color:s.color, textTransform:"capitalize" }}>{s.val}</div>
                        <div style={{ fontSize:10, color:"var(--text3)", marginTop:2 }}>{s.label}</div>
                      </Card>
                    ))}
                  </div>

                  {/* Quick links */}
                  {[
                    { label:"Start a breathing session", sub:"Guided breathwork", tab:"breathe",  Icon:Wind,       color:"#00e5ff" },
                    { label:"Meditate",                  sub:"Set your timer",    tab:"meditate", Icon:Brain,      color:"#a78bfa" },
                    { label:"Log today's mood",          sub:"How are you feeling?", tab:"mood",  Icon:Smile,      color:"#4ade80" },
                    { label:"Log last night's sleep",    sub:"Track recovery",    tab:"sleep",    Icon:BedDouble,  color:"#ffd700" },
                  ].map(q=>(
                    <button key={q.tab} onClick={()=>setWellnessTab(q.tab)}
                      style={{ display:"flex", alignItems:"center", gap:12, padding:"14px 16px", background:"rgba(255,255,255,0.02)", border:"1px solid var(--border)", borderRadius:14, cursor:"pointer", width:"100%", textAlign:"left", transition:"all 0.2s" }}
                      onMouseEnter={e=>{e.currentTarget.style.borderColor=q.color+"66"}}
                      onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border)"}}>
                      <div style={{ width:38, height:38, borderRadius:11, background:`${q.color}18`, border:`1px solid ${q.color}33`, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                        <q.Icon size={17} color={q.color} strokeWidth={2}/>
                      </div>
                      <div style={{ flex:1 }}>
                        <div style={{ fontWeight:700, fontSize:14, fontFamily:"'Syne',sans-serif", color:"var(--text)" }}>{q.label}</div>
                        <div style={{ fontSize:11, color:"var(--text3)", marginTop:1 }}>{q.sub}</div>
                      </div>
                      <ChevronRight size={16} color="var(--text3)" strokeWidth={2}/>
                    </button>
                  ))}
                </div>
              )}

              {/* ── BREATHWORK ── */}
              {wellnessTab==="breathe" && (
                <div style={{ display:"flex", flexDirection:"column", gap:14 }} className="fadein">
                  {!breathRunning ? (
                    <>
                      <div style={{ fontSize:13, color:"var(--text2)", lineHeight:1.6 }}>Choose a breathing pattern to begin. Each cycle guides your inhale, hold and exhale for measurable calm.</div>
                      {BREATH_PATTERNS.map(p=>(
                        <Card key={p.id} style={{ padding:16, cursor:"pointer", border:`1px solid ${p.color}33`, transition:"all 0.2s" }}
                          onClick={()=>startBreath(p)}
                          onMouseEnter={e=>e.currentTarget.style.borderColor=p.color+"88"}
                          onMouseLeave={e=>e.currentTarget.style.borderColor=p.color+"33"}>
                          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                            <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                              <div style={{ width:44, height:44, borderRadius:12, background:`${p.color}18`, border:`1px solid ${p.color}33`, display:"flex", alignItems:"center", justifyContent:"center" }}>
                                <Wind size={20} color={p.color} strokeWidth={2}/>
                              </div>
                              <div>
                                <div style={{ fontWeight:700, fontSize:14, fontFamily:"'Syne',sans-serif" }}>{p.name}</div>
                                <div style={{ fontSize:11, color:"var(--text3)", marginTop:2 }}>{p.desc} · {p.times.filter(t=>t>0).join("-")} pattern</div>
                              </div>
                            </div>
                            <div style={{ width:28, height:28, borderRadius:"50%", background:p.color, display:"flex", alignItems:"center", justifyContent:"center" }}>
                              <Play size={12} color="#fff" strokeWidth={2.5}/>
                            </div>
                          </div>
                        </Card>
                      ))}
                    </>
                  ) : (
                    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", padding:"20px 0", gap:20 }} className="fadein">
                      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:20, color:"var(--text2)", textTransform:"uppercase", letterSpacing:2 }}>{breathPattern.name}</div>
                      {/* Animated orb */}
                      <div style={{ position:"relative", width:200, height:200, display:"flex", alignItems:"center", justifyContent:"center" }}>
                        {/* Outer glow ring */}
                        <div style={{ position:"absolute", width:200, height:200, borderRadius:"50%", border:`2px solid ${breathPattern.color}22`, animation:"none" }}/>
                        <div style={{ position:"absolute", width:160, height:160, borderRadius:"50%", border:`1px solid ${breathPattern.color}44` }}/>
                        {/* Main orb */}
                        <div style={{
                          width:120, height:120, borderRadius:"50%",
                          background:`radial-gradient(circle at 35% 35%, ${breathPattern.color}cc, ${breathPattern.color}44)`,
                          boxShadow:`0 0 40px ${breathPattern.color}66, 0 0 80px ${breathPattern.color}22`,
                          transform:`scale(${breathScale})`,
                          transition:`transform ${breathPhase==="inhale"?(breathPattern.times[0]||2)+"s":(breathPhase==="exhale"?(breathPattern.times[2]||4)+"s":"0.3s")} ease-in-out`,
                          display:"flex", alignItems:"center", justifyContent:"center",
                        }}>
                          <div style={{ fontFamily:"'JetBrains Mono',monospace", fontWeight:600, fontSize:22, color:"#fff", textShadow:"0 2px 8px rgba(0,0,0,0.4)" }}>{breathTimer}</div>
                        </div>
                      </div>
                      {/* Phase label */}
                      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:28, letterSpacing:2, color:breathPattern.color, textTransform:"uppercase", minHeight:36 }}>{breathLabel}</div>
                      {/* Cycle count */}
                      <div style={{ display:"flex", gap:8 }}>
                        {Array.from({length:Math.max(breathCount,1)}).map((_,i)=>(
                          <div key={i} style={{ width:8, height:8, borderRadius:"50%", background:i<breathCount?breathPattern.color:"rgba(255,255,255,0.1)" }}/>
                        ))}
                      </div>
                      <div style={{ fontSize:12, color:"var(--text3)" }}>{breathCount} cycle{breathCount!==1?"s":""} complete</div>
                      <GhostBtn onClick={stopBreath} style={{ padding:"10px 28px" }}>End Session</GhostBtn>
                    </div>
                  )}
                </div>
              )}

              {/* ── MEDITATION ── */}
              {wellnessTab==="meditate" && (
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:18, padding:"10px 0" }} className="fadein">
                  {!meditRunning ? (
                    <>
                      <div style={{ textAlign:"center" }}>
                        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:22, textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>Meditation Timer</div>
                        <div style={{ fontSize:13, color:"var(--text2)" }}>Set your duration, close your eyes, and focus on your breath.</div>
                      </div>
                      {/* Duration picker */}
                      <div style={{ display:"flex", gap:10, flexWrap:"wrap", justifyContent:"center" }}>
                        {[2,5,10,15,20,30].map(d=>(
                          <button key={d} onClick={()=>setMeditDuration(d)}
                            style={{ width:60, height:60, borderRadius:14, border:`2px solid ${meditDuration===d?"#a78bfa":"var(--border2)"}`, background:meditDuration===d?"rgba(167,139,250,0.15)":"transparent", color:meditDuration===d?"#a78bfa":"var(--text3)", fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:18, cursor:"pointer", transition:"all 0.2s" }}>
                            {d}<span style={{ fontSize:10, display:"block", fontFamily:"'Syne',sans-serif", fontWeight:600 }}>min</span>
                          </button>
                        ))}
                      </div>
                      {/* Ambient preview ring */}
                      <div style={{ width:160, height:160, borderRadius:"50%", background:"radial-gradient(circle at 40% 35%, rgba(167,139,250,0.3), rgba(167,139,250,0.05))", border:"2px solid rgba(167,139,250,0.3)", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 0 40px rgba(167,139,250,0.15)" }}>
                        <div style={{ textAlign:"center" }}>
                          <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:36, color:"#a78bfa" }}>{meditDuration}</div>
                          <div style={{ fontFamily:"'Syne',sans-serif", fontSize:11, color:"rgba(167,139,250,0.7)" }}>minutes</div>
                        </div>
                      </div>
                      <PrimaryBtn onClick={()=>{setMeditElapsed(0);setMeditRunning(true);}} style={{ background:"linear-gradient(135deg,#a78bfa,#7c3aed)", padding:"14px 40px", fontSize:15, display:"flex", alignItems:"center", gap:8 }}>
                        <Play size={16} strokeWidth={2.5}/> Begin Session
                      </PrimaryBtn>
                      {/* History */}
                      {meditationLog.length>0 && (
                        <Card style={{ padding:14, width:"100%", marginTop:4 }}>
                          <div className="label" style={{ marginBottom:10 }}>Recent Sessions</div>
                          {meditationLog.slice(0,5).map((s,i)=>(
                            <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 0", borderBottom:i<Math.min(meditationLog.length,5)-1?"1px solid var(--border)":"none" }}>
                              <div style={{ display:"flex", alignItems:"center", gap:8 }}><Brain size={13} color="#a78bfa" strokeWidth={2}/><span style={{ fontSize:12, color:"var(--text2)" }}>{s.date}</span></div>
                              <span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:15, color:"#a78bfa", fontWeight:700 }}>{s.duration} min</span>
                            </div>
                          ))}
                        </Card>
                      )}
                    </>
                  ) : (
                    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:20, padding:"20px 0" }} className="fadein">
                      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:18, color:"var(--text2)", textTransform:"uppercase", letterSpacing:2 }}>Meditating…</div>
                      {/* Progress ring */}
                      <div style={{ position:"relative", width:200, height:200 }}>
                        <DonutRing value={meditElapsed} max={meditDuration*60} color="#a78bfa" size={200}/>
                        <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" }}>
                          <div style={{ fontFamily:"'JetBrains Mono',monospace", fontWeight:600, fontSize:32, color:"#a78bfa" }}>{fmt(meditDuration*60-meditElapsed)}</div>
                          <div style={{ fontSize:11, color:"var(--text3)", marginTop:4 }}>remaining</div>
                        </div>
                      </div>
                      <div style={{ fontSize:13, color:"var(--text2)", textAlign:"center", lineHeight:1.7, maxWidth:260 }}>Focus on your breath.<br/>Inhale slowly… hold… exhale.</div>
                      <GhostBtn onClick={()=>{setMeditRunning(false);setMeditElapsed(0);clearInterval(meditRef.current);}} style={{ padding:"10px 28px" }}>End Early</GhostBtn>
                    </div>
                  )}
                </div>
              )}

              {/* ── STRESS TRACKER ── */}
              {wellnessTab==="stress" && (
                <div style={{ display:"flex", flexDirection:"column", gap:14 }} className="fadein">
                  <Card style={{ padding:18 }}>
                    <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:18, textTransform:"uppercase", letterSpacing:0.5, marginBottom:6 }}>How stressed are you today?</div>
                    <div style={{ fontSize:12, color:"var(--text3)", marginBottom:18 }}>1 = totally calm · 5 = very stressed</div>
                    <div style={{ display:"flex", gap:10, justifyContent:"center", marginBottom:20 }}>
                      {[1,2,3,4,5].map(n=>{
                        const cols=["#4ade80","#a3e635","#ffd700","#e06800","#ff3d2e"];
                        const sel = stressLog.find(s=>s.date===today)?.score===n;
                        return (
                          <button key={n} onClick={()=>setStressLog(p=>{const f=p.filter(s=>s.date!==today);return [...f,{date:today,score:n}];})}
                            style={{ width:52, height:52, borderRadius:14, border:`2px solid ${sel?cols[n-1]:"var(--border2)"}`, background:sel?`${cols[n-1]}22`:"transparent", color:sel?cols[n-1]:"var(--text3)", fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:22, cursor:"pointer", transition:"all 0.2s", boxShadow:sel?`0 0 16px ${cols[n-1]}44`:"none" }}>
                            {n}
                          </button>
                        );
                      })}
                    </div>
                    {stressLog.find(s=>s.date===today) && <div style={{ textAlign:"center", fontSize:12, color:"#4ade80" }}>✓ Logged for today</div>}
                  </Card>
                  {/* Weekly chart */}
                  {stressLog.length>0 && (
                    <Card style={{ padding:16 }}>
                      <div className="label" style={{ marginBottom:12 }}>7-Day Stress Trend</div>
                      <div style={{ display:"flex", alignItems:"flex-end", gap:6, height:80 }}>
                        {stressLog.slice(-7).map((s,i)=>{
                          const cols=["#4ade80","#a3e635","#ffd700","#e06800","#ff3d2e"];
                          return (
                            <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:4 }}>
                              <div style={{ width:"100%", borderRadius:4, background:cols[s.score-1], height:`${(s.score/5)*64}px`, transition:"height 0.4s", minHeight:6 }}/>
                              <div style={{ fontSize:9, color:"var(--text3)", fontFamily:"'Syne',sans-serif" }}>{s.date.slice(5)}</div>
                            </div>
                          );
                        })}
                      </div>
                    </Card>
                  )}
                </div>
              )}

              {/* ── SLEEP LOGGER ── */}
              {wellnessTab==="sleep" && (
                <div style={{ display:"flex", flexDirection:"column", gap:14 }} className="fadein">

                  {/* Google Fit connected — auto data */}
                  {gfitToken ? (
                    <>
                      {/* Connected banner */}
                      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 14px", background:"rgba(0,229,255,0.06)", border:"1px solid rgba(0,229,255,0.2)", borderRadius:12 }}>
                        <Watch size={15} color="#00e5ff" strokeWidth={2}/>
                        <span style={{ fontSize:12, color:"#00e5ff", fontFamily:"'Syne',sans-serif", fontWeight:600 }}>Synced from Google Fit</span>
                        <button onClick={()=>fetchGfitAll(gfitToken)} style={{ marginLeft:"auto", background:"none", border:"none", cursor:"pointer", color:"#00e5ff", display:"flex", alignItems:"center" }}>
                          <RefreshCw size={13} strokeWidth={2} style={{ animation:gfitLoading?"spin 1s linear infinite":"none" }}/>
                        </button>
                      </div>

                      {/* Last night hero */}
                      {gfitSleep?.lastNight ? (
                        <Card style={{ padding:20, background:"linear-gradient(135deg,rgba(167,139,250,0.1),transparent)", border:"1px solid rgba(167,139,250,0.3)" }}>
                          <div style={{ display:"flex", alignItems:"center", gap:16 }}>
                            <DonutRing value={gfitSleep.lastNight.hours} max={9} color="#a78bfa" size={80}/>
                            <div>
                              <div className="label" style={{ marginBottom:4 }}>Last Night</div>
                              <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:48, color:"#a78bfa", lineHeight:1 }}>{gfitSleep.lastNight.hours}<span style={{ fontSize:22 }}>h</span></div>
                              <div style={{ fontSize:11, color:"var(--text3)", marginTop:4 }}>
                                {gfitSleep.lastNight.hours>=7?"✓ Good sleep":"⚠ Below recommended 7–9h"}
                              </div>
                              <div style={{ fontSize:10, color:"var(--text3)", marginTop:2 }}>{gfitSleep.lastNight.date}</div>
                            </div>
                          </div>
                        </Card>
                      ) : (
                        <Card style={{ padding:18, textAlign:"center" }}>
                          {gfitLoading
                            ? <div style={{ color:"var(--text3)", fontSize:13 }}>Fetching sleep data…</div>
                            : <><BedDouble size={28} color="var(--text3)" strokeWidth={1.5} style={{ marginBottom:8 }}/><div style={{ color:"var(--text3)", fontSize:13 }}>No sleep sessions found for this week.<br/>Make sure your device is tracking sleep in Google Fit.</div></>
                          }
                        </Card>
                      )}

                      {/* 7-day sleep chart */}
                      {gfitSleep?.entries?.length > 0 && (
                        <Card style={{ padding:16 }}>
                          <div className="label" style={{ marginBottom:12 }}>7-Night History</div>
                          <div style={{ display:"flex", alignItems:"flex-end", gap:6, height:90 }}>
                            {gfitSleep.entries.slice(0,7).reverse().map((s,i)=>(
                              <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:4 }}>
                                <div style={{ fontSize:9, color:"var(--text3)", marginBottom:2 }}>{s.hours}h</div>
                                <div style={{ width:"100%", borderRadius:5, background:s.hours>=7?"#a78bfa":s.hours>=5?"#ffd700":"#ff3d2e", height:`${Math.max((s.hours/9)*70,6)}px`, transition:"height 0.4s" }}/>
                                <div style={{ fontSize:8, color:"var(--text3)" }}>{s.date.slice(5)}</div>
                              </div>
                            ))}
                          </div>
                          <div style={{ display:"flex", gap:12, marginTop:10, justifyContent:"center" }}>
                            {[{c:"#a78bfa",l:"7h+ Good"},{c:"#ffd700",l:"5–7h Fair"},{c:"#ff3d2e",l:"<5h Poor"}].map(l=>(
                              <div key={l.l} style={{ display:"flex", alignItems:"center", gap:4 }}>
                                <div style={{ width:8, height:8, borderRadius:2, background:l.c }}/>
                                <span style={{ fontSize:9, color:"var(--text3)" }}>{l.l}</span>
                              </div>
                            ))}
                          </div>
                        </Card>
                      )}

                      {/* Sleep insights */}
                      {gfitSleep?.entries?.length > 1 && (()=>{
                        const avg = gfitSleep.entries.slice(0,7).reduce((a,e)=>a+e.hours,0) / Math.min(gfitSleep.entries.length,7);
                        const best = Math.max(...gfitSleep.entries.slice(0,7).map(e=>e.hours));
                        const worst = Math.min(...gfitSleep.entries.slice(0,7).map(e=>e.hours));
                        return (
                          <Card style={{ padding:16 }}>
                            <div className="label" style={{ marginBottom:12 }}>Weekly Insights</div>
                            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
                              {[{l:"Avg",v:`${avg.toFixed(1)}h`,c:"#a78bfa"},{l:"Best",v:`${best}h`,c:"#4ade80"},{l:"Worst",v:`${worst}h`,c:"#ff3d2e"}].map(s=>(
                                <div key={s.l} style={{ textAlign:"center", padding:"10px 8px", background:"rgba(255,255,255,0.02)", borderRadius:10 }}>
                                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:22, fontWeight:900, color:s.c }}>{s.v}</div>
                                  <div style={{ fontSize:10, color:"var(--text3)", marginTop:2 }}>{s.l}</div>
                                </div>
                              ))}
                            </div>
                          </Card>
                        );
                      })()}

                      {/* Quality override — manual rating still available */}
                      <Card style={{ padding:16 }}>
                        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, fontSize:14, textTransform:"uppercase", letterSpacing:0.5, marginBottom:10 }}>Rate Last Night's Quality</div>
                        <div style={{ display:"flex", gap:8 }}>
                          {[{v:1,l:"Poor"},{v:2,l:"Fair"},{v:3,l:"OK"},{v:4,l:"Good"},{v:5,l:"Great"}].map(q=>(
                            <button key={q.v} onClick={()=>setSleepQuality(q.v)}
                              style={{ flex:1, padding:"10px 4px", borderRadius:10, border:`1px solid ${sleepQuality===q.v?"#a78bfa":"var(--border2)"}`, background:sleepQuality===q.v?"rgba(167,139,250,0.15)":"transparent", color:sleepQuality===q.v?"#a78bfa":"var(--text3)", fontFamily:"'Syne',sans-serif", fontSize:10, fontWeight:700, cursor:"pointer", transition:"all 0.2s" }}>
                              {q.l}
                            </button>
                          ))}
                        </div>
                        <PrimaryBtn onClick={()=>{ if(gfitSleep?.lastNight){ setSleepLog(p=>{const f=p.filter(s=>s.date!==gfitSleep.lastNight.date); return [{...gfitSleep.lastNight, quality:sleepQuality, source:"googlefit"},...f].slice(0,60);}); }}} style={{ marginTop:12, fontSize:13, background:"linear-gradient(135deg,#a78bfa,#7c3aed)", display:"flex", alignItems:"center", gap:8, justifyContent:"center" }}>
                          <CheckCircle2 size={14} strokeWidth={2}/> Save Quality Rating
                        </PrimaryBtn>
                      </Card>
                    </>
                  ) : (
                    /* Not connected — prompt + manual fallback */
                    <>
                      <Card style={{ padding:20, textAlign:"center", border:"1px solid rgba(0,229,255,0.2)", background:"rgba(0,229,255,0.04)" }}>
                        <Watch size={32} color="#00e5ff" strokeWidth={1.5} style={{ marginBottom:10 }}/>
                        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:18, textTransform:"uppercase", marginBottom:6 }}>Connect Google Fit</div>
                        <div style={{ fontSize:12, color:"var(--text2)", lineHeight:1.6, marginBottom:16 }}>Link your watch to automatically sync sleep data from your device. No manual entry needed.</div>
                        <PrimaryBtn onClick={()=>setTab("watch")} style={{ background:"linear-gradient(135deg,#00e5ff,#0891b2)", fontSize:13, display:"flex", alignItems:"center", gap:8, justifyContent:"center", margin:"0 auto" }}>
                          <Watch size={14} strokeWidth={2}/> Go to Watch Tab
                        </PrimaryBtn>
                      </Card>

                      {/* Manual fallback */}
                      <Card style={{ padding:18 }}>
                        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, fontSize:14, textTransform:"uppercase", marginBottom:14, opacity:0.7 }}>Or Log Manually</div>
                        <div style={{ marginBottom:16 }}>
                          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                            <span style={{ fontSize:12, color:"var(--text3)" }}>Hours slept</span>
                            <span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:22, color:"#ffd700", fontWeight:900 }}>{sleepHours}h</span>
                          </div>
                          <input type="range" min="3" max="12" step="0.5" value={sleepHours} onChange={e=>setSleepHours(Number(e.target.value))} style={{ width:"100%", accentColor:"#ffd700" }}/>
                          <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"var(--text3)", marginTop:4 }}><span>3h</span><span>7–9h optimal</span><span>12h</span></div>
                        </div>
                        <div style={{ marginBottom:16 }}>
                          <div style={{ fontSize:12, color:"var(--text3)", marginBottom:10 }}>Sleep quality</div>
                          <div style={{ display:"flex", gap:8 }}>
                            {[{v:1,l:"Poor"},{v:2,l:"Fair"},{v:3,l:"OK"},{v:4,l:"Good"},{v:5,l:"Great"}].map(q=>(
                              <button key={q.v} onClick={()=>setSleepQuality(q.v)}
                                style={{ flex:1, padding:"10px 4px", borderRadius:10, border:`1px solid ${sleepQuality===q.v?"#ffd700":"var(--border2)"}`, background:sleepQuality===q.v?"rgba(255,215,0,0.12)":"transparent", color:sleepQuality===q.v?"#ffd700":"var(--text3)", fontFamily:"'Syne',sans-serif", fontSize:10, fontWeight:700, cursor:"pointer", transition:"all 0.2s" }}>
                                {q.l}
                              </button>
                            ))}
                          </div>
                        </div>
                        <PrimaryBtn onClick={()=>{const d=new Date().toISOString().slice(0,10);setSleepLog(p=>{const f=p.filter(s=>s.date!==d);return [{date:d,hours:sleepHours,quality:sleepQuality,source:"manual"},...f].slice(0,30);});}} style={{ background:"linear-gradient(135deg,#ffd700,#e06800)", fontSize:14, display:"flex", alignItems:"center", gap:8, justifyContent:"center" }}>
                          <BedDouble size={15} strokeWidth={2}/> Save Sleep Log
                        </PrimaryBtn>
                      </Card>

                      {/* Manual history */}
                      {sleepLog.length>0 && (
                        <Card style={{ padding:16 }}>
                          <div className="label" style={{ marginBottom:12 }}>Sleep History</div>
                          <div style={{ display:"flex", alignItems:"flex-end", gap:5, height:80 }}>
                            {sleepLog.slice(0,7).reverse().map((s,i)=>(
                              <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:4 }}>
                                <div style={{ width:"100%", borderRadius:4, background:s.hours>=7?"#4ade80":s.hours>=5?"#ffd700":"#ff3d2e", height:`${(s.hours/10)*64}px`, minHeight:6 }}/>
                                <div style={{ fontSize:9, color:"var(--text3)" }}>{s.hours}h</div>
                              </div>
                            ))}
                          </div>
                        </Card>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* ── MOOD JOURNAL ── */}
              {wellnessTab==="mood" && (
                <div style={{ display:"flex", flexDirection:"column", gap:14 }} className="fadein">
                  <Card style={{ padding:18 }}>
                    <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:18, textTransform:"uppercase", letterSpacing:0.5, marginBottom:16 }}>How are you feeling?</div>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr", gap:8, marginBottom:16 }}>
                      {MOOD_OPTIONS.map(m=>(
                        <button key={m.v} onClick={()=>setTodayMood(m.v)}
                          style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:6, padding:"12px 6px", borderRadius:14, border:`2px solid ${todayMood===m.v?m.color:"var(--border2)"}`, background:todayMood===m.v?`${m.color}18`:"transparent", cursor:"pointer", transition:"all 0.2s", boxShadow:todayMood===m.v?`0 0 16px ${m.color}44`:"none" }}>
                          <m.Icon size={22} color={todayMood===m.v?m.color:"var(--text3)"} strokeWidth={2}/>
                          <span style={{ fontSize:9, fontFamily:"'Syne',sans-serif", fontWeight:700, color:todayMood===m.v?m.color:"var(--text3)" }}>{m.label}</span>
                        </button>
                      ))}
                    </div>
                    <textarea value={moodNote} onChange={e=>setMoodNote(e.target.value)} placeholder="Optional note… what's on your mind?" rows={3}
                      style={{ width:"100%", background:"rgba(255,255,255,0.03)", border:"1px solid var(--border2)", borderRadius:12, padding:"12px 14px", color:"var(--text)", fontFamily:"'Syne',sans-serif", fontSize:13, outline:"none", resize:"none", marginBottom:14, boxSizing:"border-box" }}/>
                    <PrimaryBtn onClick={()=>{if(!todayMood)return; setMoodLog(p=>{const f=p.filter(s=>s.date!==today);return [{date:today,mood:todayMood,note:moodNote},...f].slice(0,60);}); setMoodNote(""); }} disabled={!todayMood} style={{ fontSize:14, display:"flex", alignItems:"center", gap:8, justifyContent:"center" }}>
                      <BookOpen size={15} strokeWidth={2}/> Save Mood Entry
                    </PrimaryBtn>
                  </Card>
                  {/* Mood history */}
                  {moodLog.length>0 && (
                    <Card style={{ padding:16 }}>
                      <div className="label" style={{ marginBottom:12 }}>Mood Journal</div>
                      {moodLog.slice(0,7).map((entry,i)=>{
                        const m = MOOD_OPTIONS.find(o=>o.v===entry.mood)||MOOD_OPTIONS[2];
                        return (
                          <div key={i} style={{ display:"flex", alignItems:"flex-start", gap:10, padding:"10px 0", borderBottom:i<Math.min(moodLog.length,7)-1?"1px solid var(--border)":"none" }}>
                            <div style={{ width:32, height:32, borderRadius:10, background:`${m.color}18`, border:`1px solid ${m.color}33`, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                              <m.Icon size={15} color={m.color} strokeWidth={2}/>
                            </div>
                            <div style={{ flex:1 }}>
                              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                                <span style={{ fontFamily:"'Syne',sans-serif", fontWeight:700, fontSize:13, color:m.color, textTransform:"capitalize" }}>{m.label}</span>
                                <span style={{ fontSize:10, color:"var(--text3)" }}>{entry.date}</span>
                              </div>
                              {entry.note && <div style={{ fontSize:11, color:"var(--text2)", marginTop:3, lineHeight:1.5 }}>{entry.note}</div>}
                            </div>
                          </div>
                        );
                      })}
                    </Card>
                  )}
                </div>
              )}
            </div>
          );
        })()}

      </div>

      {/* ── 🎮 CLASS PICKER MODAL ── */}
      {classPickerOpen && (
        <div onClick={()=>setClassPickerOpen(false)}
          style={{ position:"fixed", inset:0, zIndex:200, background:"rgba(0,0,0,0.85)", backdropFilter:"blur(16px)", display:"flex", alignItems:"flex-end", justifyContent:"center" }}>
          <div onClick={e=>e.stopPropagation()}
            style={{ width:"100%", maxWidth:520, maxHeight:"86vh", overflowY:"auto", background:"var(--card)", borderTopLeftRadius:24, borderTopRightRadius:24, padding:"20px 18px 40px", borderTop:"1px solid var(--border2)" }}>
            <div style={{ width:36, height:4, background:"var(--border2)", borderRadius:100, margin:"0 auto 16px" }}/>
            <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:26, textTransform:"uppercase", letterSpacing:0.5, textAlign:"center", marginBottom:6 }}>
              {characterClass ? "Change Class" : "Choose Your Class"}
            </div>
            <div style={{ fontSize:12, color:"var(--text3)", textAlign:"center", marginBottom:18, lineHeight:1.5 }}>
              Each class shapes how your workouts grow your stats. Switch later — progress stays.
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              {CLASSES.map(c=>{
                const sel = c.id === characterClass;
                const recommended = !characterClass && c.suitsGoal === profile.goal;
                return (
                  <div key={c.id} onClick={()=>{ setCharacterClass(c.id); setClassPickerOpen(false); }}
                    style={{ padding:14, borderRadius:14, cursor:"pointer", border:sel?`2px solid ${c.color}`:`1px solid var(--border2)`, background:sel?`${c.color}14`:"var(--bg2)", transition:"all 0.18s" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                      <div style={{ width:48, height:48, borderRadius:12, background:`linear-gradient(135deg,${c.color},${c.color}88)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:24, flexShrink:0, boxShadow:`0 4px 14px ${c.color}50` }}>
                        {c.emoji}
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:2, flexWrap:"wrap" }}>
                          <span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:18, textTransform:"uppercase", letterSpacing:0.3, color:c.color }}>{c.name}</span>
                          {recommended && <span style={{ fontSize:9, padding:"2px 7px", borderRadius:20, background:"rgba(74,222,128,0.18)", color:"#4ade80", fontWeight:700, fontFamily:"'Syne',sans-serif" }}>RECOMMENDED</span>}
                          {sel && <CheckCircle2 size={14} color={c.color} strokeWidth={2.5}/>}
                        </div>
                        <div style={{ fontSize:11, color:c.color, fontWeight:600, marginBottom:4, fontStyle:"italic" }}>{c.tagline}</div>
                        <div style={{ fontSize:12, color:"var(--text2)", lineHeight:1.45 }}>{c.description}</div>
                        <div style={{ display:"flex", gap:4, marginTop:6, flexWrap:"wrap" }}>
                          {Object.entries(c.statBias).filter(([,v])=>v>=1.3).map(([s])=>(
                            <span key={s} style={{ fontSize:9, padding:"2px 7px", borderRadius:20, background:"var(--border)", color:c.color, fontWeight:700, fontFamily:"'Syne',sans-serif" }}>+{s}</span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── 🎮 GAINS / LEVEL-UP TOAST ── */}
      {recentGains && (
        <div onClick={()=>setRecentGains(null)}
          style={{ position:"fixed", inset:0, zIndex:300, background:"rgba(0,0,0,0.7)", backdropFilter:"blur(8px)", display:"flex", alignItems:"center", justifyContent:"center", padding:18 }}>
          <div onClick={e=>e.stopPropagation()}
            style={{ width:"100%", maxWidth:380, background:"linear-gradient(160deg, #150510 0%, var(--card) 60%)", borderRadius:24, padding:"28px 22px", border:`1px solid ${recentGains.levelUp?"#ffd700":"var(--brand)"}55`, boxShadow:`0 20px 60px ${recentGains.levelUp?"#ffd700":"var(--brand)"}30`, textAlign:"center", animation:"fadeUp 0.4s cubic-bezier(0.16,1,0.3,1)" }}>
            {recentGains.levelUp ? (
              <>
                <div style={{ fontSize:42, marginBottom:6 }}>🎉</div>
                <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:30, color:"#ffd700", textTransform:"uppercase", letterSpacing:1.2, lineHeight:1, marginBottom:6 }}>Level Up!</div>
                <div style={{ fontSize:14, color:"var(--text2)", marginBottom:16 }}>You reached <b style={{color:"#ffd700"}}>Level {recentGains.levelUp}</b></div>
              </>
            ) : (
              <>
                <div style={{ fontSize:34, marginBottom:4 }}>💥</div>
                <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:24, color:"var(--brand)", textTransform:"uppercase", letterSpacing:1, lineHeight:1, marginBottom:14 }}>Victory!</div>
              </>
            )}
            <div style={{ padding:"12px 14px", borderRadius:14, background:"rgba(255,61,46,0.08)", border:"1px solid rgba(255,61,46,0.2)", marginBottom:12 }}>
              <div style={{ fontSize:11, color:"var(--text3)", fontWeight:700, textTransform:"uppercase", letterSpacing:0.5, marginBottom:4 }}>XP Earned</div>
              <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:32, fontWeight:900, color:"var(--brand)", lineHeight:1 }}>+{recentGains.xp}</div>
            </div>
            {recentGains.stats && Object.values(recentGains.stats).some(v=>v>0) && (
              <div style={{ display:"flex", gap:6, justifyContent:"center", flexWrap:"wrap", marginBottom:18 }}>
                {Object.entries(recentGains.stats).filter(([,v])=>v>0).map(([k,v])=>{
                  const colors = {STR:"#ff3d2e",AGI:"#ffd700",STA:"#4ade80",WIS:"#a78bfa",VIT:"#00e5ff"};
                  return (
                    <div key={k} style={{ padding:"6px 12px", borderRadius:100, background:`${colors[k]}14`, border:`1px solid ${colors[k]}44` }}>
                      <span style={{ fontSize:11, fontWeight:700, color:colors[k], fontFamily:"'Syne',sans-serif" }}>+{v} {k}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <PrimaryBtn onClick={()=>setRecentGains(null)} style={{ fontSize:13, padding:12 }}>Continue</PrimaryBtn>
          </div>
        </div>
      )}

      {/* ── BOTTOM NAV ── */}
      <div style={{ position:"fixed", bottom:0, left:0, right:0, zIndex:100, background:"rgba(6,6,14,0.95)", backdropFilter:"blur(24px)", WebkitBackdropFilter:"blur(24px)", borderTop:"1px solid rgba(255,255,255,0.05)", padding:"10px 4px 20px", display:"flex", justifyContent:"space-around" }}>
        {[
          {id:"dashboard", Icon:Home,      label:"Home"},
          {id:"train",     Icon:Dumbbell,  label:"Train"},
          {id:"scan",      Icon:Camera,    label:"Scan"},
          {id:"nutrition", Icon:Salad,     label:"Meals"},
          {id:"wellness",  Icon:Leaf,      label:"Wellness"},
          {id:"watch",     Icon:Watch,     label:"Watch"},
          {id:"progress",  Icon:BarChart2, label:"Stats"},
        ].map(({id, Icon, label})=>{
          const active = tab===id || (tab==="active"&&id==="train");
          return (
            <div key={id} onClick={()=>setTab(id)}
              style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:3, cursor:"pointer", padding:"6px 5px", borderRadius:12, transition:"all 0.2s", color: active?"var(--brand)":"var(--text3)" }}>
              <Icon size={18} strokeWidth={active?2.5:1.8} style={{ filter: active?"drop-shadow(0 0 6px rgba(255,61,46,0.55))":"none", transition:"all 0.2s" }}/>
              <span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, fontSize:7.5, letterSpacing:0.8, textTransform:"uppercase" }}>{label}</span>
              {active && <div className="nav-dot"/>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
