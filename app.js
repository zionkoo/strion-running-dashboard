import { Decoder, Stream } from "https://esm.sh/@garmin/fitsdk@21.218.0";

const $ = (selector) => document.querySelector(selector);
const uploadView = $("#uploadView");
const loadingView = $("#loadingView");
const dashboardView = $("#dashboardView");
const errorView = $("#errorView");
const fileInput = $("#fileInput");
const dropZone = $("#dropZone");

let activity = null;
let timelineChart = null;
let paceStrategyChart = null;
let historyChart = null;
let dynamicsCharts = [];
let selectedPaceStrategy = "even";
let calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let deferredInstallPrompt = null;

const PROFILE_STORAGE_KEY = "strionProfileV1";
const COLLAPSE_STORAGE_KEY = "strionCollapsedSectionsV1";
let runnerProfile = loadRunnerProfile();

const chartConfig = {
  pace: { label: "페이스", color: "#ff3df2", unit: "/km", reverse: true },
  heartRate: { label: "심박", color: "#d93624", unit: "bpm" },
  cadence: { label: "케이던스", color: "#50ecff", unit: "spm" },
  power: { label: "러닝 파워", color: "#6d4b28", unit: "W" },
  altitude: { label: "고도", color: "#66685e", unit: "m" },
};

const neonLinePlugin = {
  id: "strionNeonLine",
  beforeDatasetDraw(chart, args) {
    const meta = chart.getDatasetMeta(args.index);
    if (meta.type !== "line") return;
    const color = chart.data.datasets[args.index].borderColor || "#50ecff";
    chart.ctx.save();
    chart.ctx.shadowColor = color;
    chart.ctx.shadowBlur = 14;
    chart.ctx.shadowOffsetX = 0;
    chart.ctx.shadowOffsetY = 0;
    chart.ctx.lineCap = "round";
    chart.ctx.lineJoin = "round";
  },
  afterDatasetDraw(chart, args) {
    if (chart.getDatasetMeta(args.index).type === "line") chart.ctx.restore();
  },
};

if (typeof Chart !== "undefined") Chart.register(neonLinePlugin);

function setView(view) {
  [uploadView, loadingView, dashboardView, errorView].forEach((element) => element.classList.add("hidden"));
  view.classList.remove("hidden");
}

function openPicker(event) {
  event?.stopPropagation();
  fileInput.click();
}

dropZone.addEventListener("click", openPicker);
dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") openPicker(event);
});
$("#chooseFileButton").addEventListener("click", openPicker);
fileInput.addEventListener("change", () => fileInput.files.length && analyzeFiles([...fileInput.files]));

["dragenter", "dragover"].forEach((type) => dropZone.addEventListener(type, (event) => {
  event.preventDefault();
  dropZone.classList.add("dragging");
}));
["dragleave", "drop"].forEach((type) => dropZone.addEventListener(type, (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
}));
dropZone.addEventListener("drop", (event) => {
  const files = [...event.dataTransfer.files];
  if (files.length) analyzeFiles(files);
});

$("#newFileButton").addEventListener("click", resetDashboard);
$("#retryButton").addEventListener("click", resetDashboard);
$("#openProfileButton").addEventListener("click", openProfileDialog);
$("#closeProfileButton").addEventListener("click", () => $("#profileDialog").close());
$("#raceForm").addEventListener("submit", saveRace);
$("#raceForm").addEventListener("input", updateTargetPacePreview);
$("#raceForm").addEventListener("change", updateTargetPacePreview);
$("#pbForm").addEventListener("submit", savePersonalBests);
$("#goalPaceCalculator").addEventListener("input", updateGoalPaceAnalyzer);
$("#goalPaceCalculator").addEventListener("change", updateGoalPaceAnalyzer);
$("#paceStrategyButtons").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-strategy]");
  if (!button) return;
  selectedPaceStrategy = button.dataset.strategy;
  document.querySelectorAll("#paceStrategyButtons button").forEach((item) => item.classList.toggle("active", item === button));
  updateGoalPaceAnalyzer();
});
$("#strategyStrength").addEventListener("change", updateGoalPaceAnalyzer);
$("#workoutPlanForm").addEventListener("submit", saveWorkoutPlan);
$("#workoutPlanList").addEventListener("click", handleWorkoutPlanAction);
$("#activityHistoryList").addEventListener("click", deleteActivitySummary);
$("#weeklyGoalForm").addEventListener("submit", saveWeeklyGoals);
$("#previousMonthButton").addEventListener("click", () => changeCalendarMonth(-1));
$("#nextMonthButton").addEventListener("click", () => changeCalendarMonth(1));
$("#currentMonthButton").addEventListener("click", () => {
  calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  renderRunningCalendar();
});
document.querySelectorAll('input[name="paceGoalTime"], input[name="targetTime"], #pbForm input').forEach((input) => {
  input.addEventListener("blur", normalizeDurationField);
});
$("#savedRaceList").addEventListener("click", deleteRace);
$("#chartTabs").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-chart]");
  if (!button || !activity) return;
  document.querySelectorAll("#chartTabs button").forEach((item) => item.classList.toggle("active", item === button));
  renderTimeline(button.dataset.chart);
});
$("#maxHeartRateInput").addEventListener("input", (event) => {
  const value = Number(event.currentTarget.value);
  runnerProfile.maxHeartRate = value >= 100 && value <= 240 ? value : null;
  persistRunnerProfile();
  if (activity) renderHeartRateZones(activity);
});
$("#useLocationButton").addEventListener("click", requestLocalWeather);
$("#compareBaseSelect").addEventListener("change", renderRunComparison);
$("#compareTargetSelect").addEventListener("change", renderRunComparison);
$("#exportDataButton").addEventListener("click", exportRunnerData);
$("#importDataButton").addEventListener("click", () => $("#importDataInput").click());
$("#importDataInput").addEventListener("change", importRunnerData);
$("#installAppButton").addEventListener("click", installStrionApp);

renderPersonalHub();
updateGoalPaceAnalyzer();
renderTrainingCenter();
initializeCollapsibles();
startLiveClock();
loadWeather(37.5665, 126.9780, "서울");
initializePwa();
$("#workoutPlanForm").elements.date.value = toDateInputValue(new Date());

function startLiveClock() {
  const update = () => {
    const now = new Date();
    $("#currentDate").textContent = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "long" }).format(now);
    $("#currentTime").textContent = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(now);
  };
  update();
  window.setInterval(update, 1000);
}

function requestLocalWeather() {
  const button = $("#useLocationButton");
  if (!navigator.geolocation) {
    button.textContent = "위치 미지원";
    return;
  }
  button.disabled = true;
  button.textContent = "위치 확인 중";
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => loadWeather(coords.latitude, coords.longitude, "현재 위치"),
    () => {
      button.disabled = false;
      button.textContent = "위치 권한 필요";
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 900000 },
  );
}

async function loadWeather(latitude, longitude, locationLabel) {
  const endpoint = new URL("https://api.open-meteo.com/v1/forecast");
  endpoint.search = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max",
    timezone: "auto",
    forecast_days: "7",
  });
  try {
    const response = await fetch(endpoint);
    if (!response.ok) throw new Error("Weather request failed");
    const weather = await response.json();
    renderWeatherForecast(weather.daily, locationLabel);
    $("#useLocationButton").disabled = false;
    $("#useLocationButton").textContent = locationLabel === "서울" ? "현재 위치" : "위치 갱신";
  } catch {
    $("#weatherForecast").innerHTML = '<p class="weather-loading">예보를 불러오지 못했습니다. 인터넷 연결을 확인해주세요.</p>';
    $("#useLocationButton").disabled = false;
    $("#useLocationButton").textContent = "다시 시도";
  }
}

function renderWeatherForecast(daily, locationLabel) {
  if (!daily?.time?.length) throw new Error("No forecast data");
  $("#weatherTitle").textContent = `${locationLabel} · 7일 러닝 예보`;
  $("#weatherForecast").innerHTML = daily.time.map((date, index) => {
    const weather = weatherCodeLabel(daily.weather_code[index]);
    const day = new Intl.DateTimeFormat("ko-KR", { weekday: "short" }).format(dateFromInput(date));
    const rain = Math.round(daily.precipitation_probability_max[index] || 0);
    const wind = Math.round(daily.wind_speed_10m_max[index] || 0);
    return `<article class="forecast-day ${index === 0 ? "today" : ""}">
      <span>${index === 0 ? "오늘" : day}</span>
      <i class="weather-code">${weather.code}</i>
      <strong>${Math.round(daily.temperature_2m_max[index])}° <small>${Math.round(daily.temperature_2m_min[index])}°</small></strong>
      <p>${weather.label}</p>
      <small>강수 ${rain}% · 바람 ${wind}km/h</small>
    </article>`;
  }).join("");
}

function weatherCodeLabel(code) {
  if (code === 0) return { code: "CLR", label: "맑음" };
  if ([1, 2].includes(code)) return { code: "PART", label: "구름 조금" };
  if (code === 3) return { code: "CLD", label: "흐림" };
  if ([45, 48].includes(code)) return { code: "FOG", label: "안개" };
  if ([51, 53, 55, 56, 57].includes(code)) return { code: "DRZ", label: "이슬비" };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { code: "RAIN", label: "비" };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { code: "SNOW", label: "눈" };
  if ([95, 96, 99].includes(code)) return { code: "STM", label: "뇌우" };
  return { code: "VAR", label: "변화 가능" };
}

function initializeCollapsibles() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(COLLAPSE_STORAGE_KEY) || "{}"); } catch { stored = {}; }
  const targets = [
    ["goal-pace", ".goal-pace-lab", ".goal-pace-heading", false],
    ["training-center", ".training-center", ".training-center-heading", false],
    ["vdot-coach", "#vdotCoachPanel", ".panel-heading", true],
    ["timeline", ".chart-panel", ".panel-heading", false],
    ["splits", ".two-column > .panel:first-child", ".panel-heading", false],
    ["heart-rate", ".zones-panel", ".panel-heading", false],
    ["route", "#routePanel", ".panel-heading", true],
    ["dynamics", "#dynamicsPanel", ".panel-heading", false],
  ];

  targets.forEach(([key, sectionSelector, headerSelector, defaultCollapsed]) => {
    const section = document.querySelector(sectionSelector);
    const header = section?.querySelector(headerSelector);
    if (!section || !header || header.querySelector(".collapse-button")) return;
    section.classList.add("collapsible-section");
    header.classList.add("collapsible-header");
    section.dataset.collapseKey = key;
    const isCollapsed = key in stored ? Boolean(stored[key]) : defaultCollapsed;
    section.classList.toggle("is-collapsed", isCollapsed);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "collapse-button";
    button.setAttribute("aria-expanded", String(!isCollapsed));
    button.innerHTML = `<span>${isCollapsed ? "펼치기" : "접기"}</span><i aria-hidden="true"></i>`;
    button.addEventListener("click", () => toggleCollapsible(section, button));
    header.append(button);
  });
}

function toggleCollapsible(section, button) {
  const collapsed = section.classList.toggle("is-collapsed");
  button.setAttribute("aria-expanded", String(!collapsed));
  button.querySelector("span").textContent = collapsed ? "펼치기" : "접기";
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(COLLAPSE_STORAGE_KEY) || "{}"); } catch { stored = {}; }
  stored[section.dataset.collapseKey] = collapsed;
  localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(stored));
  window.setTimeout(() => window.dispatchEvent(new Event("resize")), 20);
}

function loadRunnerProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY));
    return {
      races: Array.isArray(saved?.races) ? saved.races : [],
      pbs: saved?.pbs && typeof saved.pbs === "object" ? saved.pbs : {},
      workouts: Array.isArray(saved?.workouts) ? saved.workouts : [],
      activities: Array.isArray(saved?.activities) ? saved.activities : [],
      maxHeartRate: Number(saved?.maxHeartRate) || null,
      weeklyGoals: {
        distance: Number(saved?.weeklyGoals?.distance) || 30,
        runs: Number(saved?.weeklyGoals?.runs) || 3,
      },
    };
  } catch {
    return { races: [], pbs: {}, workouts: [], activities: [], maxHeartRate: null, weeklyGoals: { distance: 30, runs: 3 } };
  }
}

function persistRunnerProfile() {
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(runnerProfile));
}

function renderPersonalHub() {
  const today = startOfLocalDay(new Date());
  const upcoming = runnerProfile.races
    .map((race) => ({ ...race, days: daysUntil(race.date, today) }))
    .filter((race) => race.days >= 0)
    .sort((a, b) => a.days - b.days);
  const next = upcoming[0];
  const card = $("#nextRaceCard");

  if (next) {
    card.classList.remove("empty");
    $("#nextRaceName").textContent = next.name;
    $("#nextRaceMeta").textContent = `${formatRaceDate(next.date)} · ${distanceLabel(next.distance)}${next.location ? ` · ${next.location}` : ""}`;
    $("#raceDday").textContent = next.days === 0 ? "D-DAY" : `D–${next.days}`;
    $("#raceTargetTime").textContent = next.targetTime;
    $("#raceTargetPace").textContent = `${formatPace(parseClockTime(next.targetTime) / Number(next.distance))} /km`;
  } else {
    card.classList.add("empty");
    $("#nextRaceName").textContent = "다음 대회를 등록하세요";
    $("#nextRaceMeta").textContent = "일정과 목표 기록을 입력하면 D-day와 목표 페이스를 계산합니다.";
    $("#raceDday").textContent = "D–?";
    $("#raceTargetTime").textContent = "--:--:--";
    $("#raceTargetPace").textContent = "--:-- /km";
  }

  const pbLabels = [["5k", "5K"], ["10k", "10K"], ["half", "HALF"], ["full", "FULL"]];
  $("#pbGrid").innerHTML = pbLabels.map(([key, label]) => `
    <div class="pb-item"><span>${label}</span><strong>${escapeHtml(runnerProfile.pbs[key] || "--:--:--")}</strong></div>
  `).join("");

  $("#upcomingRaceList").innerHTML = upcoming.length
    ? upcoming.slice(0, 3).map((race) => `
      <div class="upcoming-race">
        <div><strong>${escapeHtml(race.name)}</strong><span>${formatRaceDate(race.date)} · ${distanceLabel(race.distance)}</span></div>
        <b>${race.days === 0 ? "TODAY" : `D-${race.days}`}</b>
      </div>
    `).join("")
    : '<p class="empty-copy">등록된 예정 대회가 없습니다.</p>';
}

function openProfileDialog() {
  const form = $("#pbForm");
  for (const [key, value] of Object.entries(runnerProfile.pbs)) {
    if (form.elements[key]) form.elements[key].value = value;
  }
  renderSavedRaces();
  updateTargetPacePreview();
  $("#profileDialog").showModal();
}

function updateTargetPacePreview() {
  const form = $("#raceForm");
  const distance = Number(form.elements.distance.value);
  const targetInput = form.elements.targetTime;
  const targetTime = targetInput.value.trim();
  const seconds = targetTime && targetInput.validity.valid ? parseClockTime(targetTime) : 0;
  const value = seconds > 0 && distance > 0 ? formatPace(seconds / distance) : "--:--";
  $("#targetPacePreview strong").innerHTML = `${value} <small>/km</small>`;
}

function updateGoalPaceAnalyzer() {
  const calculator = $("#goalPaceCalculator");
  const distance = Number(calculator.querySelector('[name="paceDistance"]').value);
  const input = calculator.querySelector('[name="paceGoalTime"]');
  const totalSeconds = parseDurationInput(input.value);
  const checkpoint = distance === 10
    ? { label: "5K 통과", distance: 5 }
    : distance === 21.0975
      ? { label: "10K 통과", distance: 10 }
      : { label: "하프 통과", distance: 21.0975 };

  $("#goalCheckpointLabel").textContent = checkpoint.label;
  if (!totalSeconds) {
    $("#goalPacePerKm").textContent = "--:--";
    $("#goalPace400").textContent = "--:--";
    $("#goalCheckpointTime").textContent = "--:--:--";
    renderPaceBlueprint([], 0);
    return;
  }

  const pace = totalSeconds / distance;
  $("#goalPacePerKm").textContent = formatPace(pace);
  $("#goalPace400").textContent = formatShortDuration(pace * 0.4);
  $("#goalCheckpointTime").textContent = formatDuration(pace * checkpoint.distance);
  renderPaceBlueprint(buildPaceBlueprint(distance, totalSeconds), pace);
}

function buildPaceBlueprint(distance, totalSeconds) {
  const strength = Number($("#strategyStrength").value);
  const segmentCount = Math.ceil(distance);
  const averagePace = totalSeconds / distance;
  const segments = Array.from({ length: segmentCount }, (_, index) => {
    const segmentDistance = Math.min(1, distance - index);
    const progress = segmentCount === 1 ? 0.5 : index / (segmentCount - 1);
    let factor = 1;
    if (selectedPaceStrategy === "negative") factor = 1 + strength - progress * strength * 2;
    if (selectedPaceStrategy === "positive") factor = 1 - strength + progress * strength * 2;
    return { index: index + 1, distance: segmentDistance, rawSeconds: averagePace * factor * segmentDistance };
  });

  const scale = totalSeconds / segments.reduce((sum, segment) => sum + segment.rawSeconds, 0);
  let cumulative = 0;
  return segments.map((segment) => {
    const seconds = segment.rawSeconds * scale;
    cumulative += seconds;
    return { ...segment, seconds, pace: seconds / segment.distance, cumulative };
  });
}

function renderPaceBlueprint(segments, averagePace) {
  const descriptions = {
    positive: "초반에 여유를 쓰고 후반 부담을 낮추는 전략입니다. 더운 날이나 장거리 첫 도전에 보수적으로 사용하세요.",
    even: "처음부터 끝까지 같은 페이스를 유지하는 전략입니다. 평탄한 코스에서 가장 단순하고 예측하기 쉽습니다.",
    negative: "초반을 절제하고 후반으로 갈수록 속도를 올리는 전략입니다. 컨디션이 좋고 페이스 감각이 안정적일 때 적합합니다.",
  };
  $("#strategyDescription").textContent = descriptions[selectedPaceStrategy];
  $("#strategyStrength").disabled = selectedPaceStrategy === "even";

  $("#paceStrategyRows").innerHTML = segments.length
    ? segments.map((segment) => `<tr><td>${segment.distance < 1 ? `${segment.distance.toFixed(3)}km` : `${segment.index}km`}</td><td>${formatPace(segment.pace)}/km</td><td>${formatDuration(segment.cumulative)}</td></tr>`).join("")
    : '<tr><td colspan="3">목표 기록을 입력해주세요.</td></tr>';

  paceStrategyChart?.destroy();
  paceStrategyChart = null;
  if (!segments.length || typeof Chart === "undefined") return;

  paceStrategyChart = new Chart($("#paceStrategyChart"), {
    type: "line",
    data: {
      labels: segments.map((segment) => segment.distance < 1 ? "FIN" : segment.index),
      datasets: [
        { label: "구간 목표", data: segments.map((segment) => segment.pace), borderColor: "#50ecff", backgroundColor: "#50ecff22", borderWidth: 2.5, pointRadius: 1.5, stepped: true, fill: true },
        { label: "평균", data: segments.map(() => averagePace), borderColor: "#ff3df2", borderDash: [6, 6], borderWidth: 1.5, pointRadius: 0 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: "#b9bbb2", boxWidth: 12 } }, tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${formatPace(item.parsed.y)}/km` } } },
      scales: {
        x: { title: { display: true, text: "거리 (km)", color: "#85867f" }, ticks: { color: "#85867f", maxTicksLimit: 10 }, grid: { color: "#33342f" } },
        y: { reverse: true, ticks: { color: "#85867f", callback: (value) => formatPace(value) }, grid: { color: "#33342f" } },
      },
    },
  });
}

function parseDurationInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  if (raw.includes(":")) {
    return /^(?:\d{1,2}:)?[0-5]\d:[0-5]\d$/.test(raw) ? parseClockTime(raw) : 0;
  }

  if (!/^\d{1,6}$/.test(raw)) return 0;
  const digits = raw.padStart(6, "0");
  const minutes = Number(digits.slice(2, 4));
  const seconds = Number(digits.slice(4, 6));
  if (minutes > 59 || seconds > 59) return 0;
  return Number(digits.slice(0, 2)) * 3600 + minutes * 60 + seconds;
}

function normalizeDurationField(event) {
  const input = event.currentTarget;
  const raw = input.value.trim();
  if (!raw || raw.includes(":")) return;

  const digits = raw.replace(/\D/g, "").slice(-6).padStart(6, "0");
  const hours = digits.slice(0, 2);
  const minutes = digits.slice(2, 4);
  const seconds = digits.slice(4, 6);
  if (Number(minutes) > 59 || Number(seconds) > 59) return;

  input.value = `${hours}:${minutes}:${seconds}`;
  if (input.name === "targetTime") updateTargetPacePreview();
  if (input.name === "paceGoalTime") updateGoalPaceAnalyzer();
}

function saveRace(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  runnerProfile.races.push({
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`,
    name: String(data.get("name")).trim(),
    date: String(data.get("date")),
    distance: Number(data.get("distance")),
    targetTime: normalizeClockTime(String(data.get("targetTime"))),
    location: String(data.get("location")).trim(),
  });
  runnerProfile.races.sort((a, b) => a.date.localeCompare(b.date));
  persistRunnerProfile();
  renderPersonalHub();
  renderSavedRaces();
  event.currentTarget.reset();
  updateTargetPacePreview();
}

function savePersonalBests(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  for (const key of ["5k", "10k", "half", "full"]) {
    const value = String(data.get(key) || "").trim();
    runnerProfile.pbs[key] = value ? normalizeClockTime(value) : "";
  }
  persistRunnerProfile();
  renderPersonalHub();
  if (activity) renderVdotCoach(activity);
}

function renderSavedRaces() {
  $("#savedRaceList").innerHTML = runnerProfile.races.length
    ? runnerProfile.races.map((race) => `
      <div class="saved-race-row">
        <div><strong>${escapeHtml(race.name)}</strong><span>${formatRaceDate(race.date)} · ${distanceLabel(race.distance)} · 목표 ${escapeHtml(race.targetTime)} · ${formatPace(parseClockTime(race.targetTime) / Number(race.distance))}/km</span></div>
        <button class="delete-button" type="button" data-race-id="${race.id}">삭제</button>
      </div>
    `).join("")
    : '<p class="empty-copy">저장된 대회가 없습니다.</p>';
}

function deleteRace(event) {
  const button = event.target.closest("button[data-race-id]");
  if (!button) return;
  runnerProfile.races = runnerProfile.races.filter((race) => race.id !== button.dataset.raceId);
  persistRunnerProfile();
  renderPersonalHub();
  renderSavedRaces();
}

function saveWorkoutPlan(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  runnerProfile.workouts.push({
    id: crypto.randomUUID ? crypto.randomUUID() : `workout-${Date.now()}`,
    date: String(data.get("date")),
    type: String(data.get("type")),
    title: String(data.get("title")).trim(),
    distance: Number(data.get("distance")) || null,
    targetPace: String(data.get("targetPace") || "").trim(),
    completed: false,
  });
  runnerProfile.workouts.sort((a, b) => a.date.localeCompare(b.date));
  persistRunnerProfile();
  renderTrainingCenter();
  event.currentTarget.reset();
  event.currentTarget.elements.date.value = toDateInputValue(new Date());
}

function handleWorkoutPlanAction(event) {
  const button = event.target.closest("button[data-workout-id]");
  if (!button) return;
  const workout = runnerProfile.workouts.find((item) => item.id === button.dataset.workoutId);
  if (!workout) return;
  if (button.dataset.action === "toggle") workout.completed = !workout.completed;
  if (button.dataset.action === "delete") runnerProfile.workouts = runnerProfile.workouts.filter((item) => item.id !== workout.id);
  persistRunnerProfile();
  renderTrainingCenter();
}

function renderTrainingCenter() {
  const workouts = [...runnerProfile.workouts].sort((a, b) => a.date.localeCompare(b.date));
  $("#workoutPlanList").innerHTML = workouts.length
    ? workouts.slice(0, 8).map((workout) => `
      <div class="workout-plan-row ${workout.completed ? "completed" : ""}">
        <span class="workout-type">${escapeHtml(workout.type)}</span>
        <div class="workout-plan-copy"><strong>${escapeHtml(workout.title)}</strong><span>${formatCompactDate(workout.date)}${workout.distance ? ` · ${workout.distance}km` : ""}${workout.targetPace ? ` · ${escapeHtml(workout.targetPace)}/km` : ""}</span></div>
        <div class="workout-plan-actions">
          <button class="mini-button" type="button" data-action="toggle" data-workout-id="${workout.id}">${workout.completed ? "되돌리기" : "완료"}</button>
          <button class="mini-button" type="button" data-action="delete" data-workout-id="${workout.id}">삭제</button>
        </div>
      </div>`).join("")
    : '<p class="empty-copy">첫 훈련 일정을 추가해보세요.</p>';

  const activities = [...runnerProfile.activities].sort((a, b) => b.date.localeCompare(a.date));
  $("#historyDistance").textContent = `${activities.reduce((sum, item) => sum + item.distanceKm, 0).toFixed(1)} km`;
  $("#historyCount").textContent = `${activities.length}회`;
  $("#historyDuration").textContent = formatDuration(activities.reduce((sum, item) => sum + item.duration, 0));
  $("#activityHistoryList").innerHTML = activities.length
    ? activities.slice(0, 5).map((item) => `
      <div class="activity-history-row">
        <span>${formatCompactDate(item.date)} · ${escapeHtml(item.name || "러닝")}</span>
        <b>${item.distanceKm.toFixed(2)}km · ${formatPace(item.pace)}/km</b>
        <button class="mini-button" type="button" data-activity-id="${item.id}">삭제</button>
      </div>`).join("")
    : '<p class="empty-copy">FIT 파일을 분석하면 러닝 요약이 여기에 쌓입니다.</p>';
  renderWeeklyGoals(activities);
  renderRunningCalendar();
  renderHistoryChart(activities);
  renderWeeklyReport(activities);
  populateRunComparison(activities);
}

function saveWeeklyGoals(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  runnerProfile.weeklyGoals = {
    distance: Math.max(1, Number(data.get("distance")) || 30),
    runs: Math.max(1, Number(data.get("runs")) || 3),
  };
  persistRunnerProfile();
  renderTrainingCenter();
}

function renderWeeklyGoals(activities) {
  const goals = runnerProfile.weeklyGoals || { distance: 30, runs: 3 };
  const form = $("#weeklyGoalForm");
  form.elements.distance.value = goals.distance;
  form.elements.runs.value = goals.runs;
  const start = startOfWeek(new Date());
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const thisWeek = activities.filter((item) => {
    const date = dateFromInput(item.date);
    return date >= start && date < end;
  });
  const distance = thisWeek.reduce((sum, item) => sum + item.distanceKm, 0);
  $("#weeklyDistanceText").textContent = `${distance.toFixed(1)} / ${goals.distance} km`;
  $("#weeklyRunsText").textContent = `${thisWeek.length} / ${goals.runs}회`;
  $("#weeklyDistanceBar").style.width = `${Math.min(100, distance / goals.distance * 100)}%`;
  $("#weeklyRunsBar").style.width = `${Math.min(100, thisWeek.length / goals.runs * 100)}%`;
}

function changeCalendarMonth(offset) {
  calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + offset, 1);
  renderRunningCalendar();
}

function renderRunningCalendar() {
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  $("#calendarTitle").textContent = `${year}년 ${month + 1}월`;
  const first = new Date(year, month, 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - mondayOffset);
  const todayKey = toDateInputValue(new Date());
  const activityDates = new Set(runnerProfile.activities.map((item) => item.date));
  const planDates = new Set(runnerProfile.workouts.map((item) => item.date));

  $("#runningCalendar").innerHTML = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const key = toDateInputValue(date);
    const markers = `${activityDates.has(key) ? '<i class="activity-dot" title="완료 러닝"></i>' : ''}${planDates.has(key) ? '<i class="plan-dot" title="훈련 계획"></i>' : ''}`;
    return `<div class="calendar-day ${date.getMonth() !== month ? "other-month" : ""} ${key === todayKey ? "today" : ""}"><b>${date.getDate()}</b><span class="calendar-markers">${markers}</span></div>`;
  }).join("");
}

function saveActivitySummary(data) {
  const id = `${data.startTime.toISOString()}-${Math.round(data.totalDistance)}`;
  const score = calculateRunScore(data);
  const summary = {
    id,
    date: toDateInputValue(data.startTime),
    timestamp: data.startTime.toISOString(),
    name: data.workoutName || "러닝",
    distanceKm: data.totalDistance / 1000,
    duration: data.totalTime,
    pace: speedToPace(data.averageSpeed),
    heartRate: data.averageHeartRate || null,
    cadence: data.averageCadence || null,
    ascent: data.ascent || null,
    score: score.total,
    paceScore: score.pace,
    finishScore: score.finish,
    heartScore: score.heart,
    cadenceScore: score.cadence,
  };
  const index = runnerProfile.activities.findIndex((item) => item.id === id);
  if (index >= 0) runnerProfile.activities[index] = summary;
  else runnerProfile.activities.push(summary);
  runnerProfile.activities = runnerProfile.activities.slice(-100);
  persistRunnerProfile();
  renderTrainingCenter();
}

function deleteActivitySummary(event) {
  const button = event.target.closest("button[data-activity-id]");
  if (!button) return;
  runnerProfile.activities = runnerProfile.activities.filter((item) => item.id !== button.dataset.activityId);
  persistRunnerProfile();
  renderTrainingCenter();
}

function renderHistoryChart(activities) {
  const currentWeek = startOfWeek(new Date());
  const weeks = Array.from({ length: 8 }, (_, index) => {
    const start = new Date(currentWeek);
    start.setDate(start.getDate() - (7 - index) * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    const values = activities.filter((item) => {
      const date = dateFromInput(item.date);
      return date >= start && date < end;
    });
    return {
      label: `${start.getMonth() + 1}/${start.getDate()}`,
      distance: values.reduce((sum, item) => sum + item.distanceKm, 0),
      count: values.length,
    };
  });

  historyChart?.destroy();
  if (typeof Chart === "undefined") return;
  historyChart = new Chart($("#historyChart"), {
    type: "bar",
    data: {
      labels: weeks.map((week) => week.label),
      datasets: [
        { label: "주간 거리 km", data: weeks.map((week) => week.distance), backgroundColor: "transparent", borderColor: "#8ba5ff", borderWidth: 2, borderRadius: 0, yAxisID: "y" },
        { type: "line", label: "러닝 횟수", data: weeks.map((week) => week.count), borderColor: "#ff3df2", backgroundColor: "#ff3df2", pointRadius: 3, tension: .25, yAxisID: "count" },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#6b6c65", boxWidth: 11 } } },
      scales: {
        x: { ticks: { color: "#6b6c65" }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: "#6b6c65" }, grid: { color: "#dedcd3" } },
        count: { beginAtZero: true, position: "right", ticks: { color: "#6b6c65", stepSize: 1 }, grid: { display: false } },
      },
    },
  });
}

function renderWeeklyReport(activities) {
  const thisStart = startOfWeek(new Date());
  const thisEnd = new Date(thisStart);
  thisEnd.setDate(thisEnd.getDate() + 7);
  const previousStart = new Date(thisStart);
  previousStart.setDate(previousStart.getDate() - 7);
  const current = activities.filter((item) => {
    const date = dateFromInput(item.date);
    return date >= thisStart && date < thisEnd;
  });
  const previous = activities.filter((item) => {
    const date = dateFromInput(item.date);
    return date >= previousStart && date < thisStart;
  });
  const currentDistance = current.reduce((sum, item) => sum + item.distanceKm, 0);
  const previousDistance = previous.reduce((sum, item) => sum + item.distanceKm, 0);
  const distanceChange = previousDistance ? (currentDistance - previousDistance) / previousDistance * 100 : null;
  const averageScore = average(current.map((item) => item.score));
  const highIntensityRuns = runnerProfile.maxHeartRate
    ? current.filter((item) => item.heartRate / runnerProfile.maxHeartRate >= .8).length
    : 0;

  $("#weeklyReportMetrics").innerHTML = [
    ["이번 주 거리", `${currentDistance.toFixed(1)} km`],
    ["지난주 대비", Number.isFinite(distanceChange) ? `${distanceChange >= 0 ? "+" : ""}${Math.round(distanceChange)}%` : "비교 대기"],
    ["평균 RUN SCORE", Number.isFinite(averageScore) ? Math.round(averageScore) : "--"],
  ].map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join("");

  let status = "READY";
  let advice = "이번 주 첫 러닝은 30–40분 편안한 E 페이스로 시작해 몸 상태를 확인해보세요.";
  if (current.length) {
    if (Number.isFinite(distanceChange) && distanceChange > 25) {
      status = "RECOVER";
      advice = "주간 거리가 지난주보다 크게 늘었습니다. 다음 러닝은 회복주로 두고 수면과 근육 피로를 먼저 확인하세요.";
    } else if (highIntensityRuns >= 2) {
      status = "EASY NEXT";
      advice = "높은 심박 강도의 러닝이 두 번 이상입니다. 다음 세션은 대화 가능한 강도의 이지런 또는 휴식을 추천합니다.";
    } else if (averageScore >= 82 && current.length >= 2) {
      status = "BUILD";
      advice = "일관성이 좋은 한 주입니다. 컨디션이 괜찮다면 다음 주 총거리를 5–10% 이내에서만 늘려보세요.";
    } else {
      status = "BALANCED";
      advice = "현재 부하는 안정적입니다. 이지런 중심을 유지하고 주 1회만 품질 훈련을 배치해보세요.";
    }
  }
  $("#weeklyReportStatus").textContent = status;
  $("#weeklyReportAdvice").textContent = advice;
}

function populateRunComparison(activities) {
  const baseSelect = $("#compareBaseSelect");
  const targetSelect = $("#compareTargetSelect");
  const previousBase = baseSelect.value;
  const previousTarget = targetSelect.value;
  const options = activities.map((item) => `<option value="${escapeHtml(item.id)}">${formatCompactDate(item.date)} · ${item.distanceKm.toFixed(1)}km</option>`).join("");
  baseSelect.innerHTML = options || '<option value="">기록 없음</option>';
  targetSelect.innerHTML = options || '<option value="">기록 없음</option>';
  if (activities.length) {
    baseSelect.value = activities.some((item) => item.id === previousBase) ? previousBase : activities[Math.min(1, activities.length - 1)].id;
    targetSelect.value = activities.some((item) => item.id === previousTarget) ? previousTarget : activities[0].id;
  }
  renderRunComparison();
}

function renderRunComparison() {
  const base = runnerProfile.activities.find((item) => item.id === $("#compareBaseSelect").value);
  const target = runnerProfile.activities.find((item) => item.id === $("#compareTargetSelect").value);
  if (!base || !target || runnerProfile.activities.length < 2) {
    $("#runComparison").innerHTML = '<p class="comparison-empty">서로 다른 FIT 활동을 두 개 이상 분석하면 기록을 비교할 수 있습니다.</p>';
    return;
  }
  const fields = [
    { label: "RUN SCORE", a: base.score, b: target.score, format: (value) => Number.isFinite(value) ? Math.round(value) : "--", better: "max" },
    { label: "거리", a: base.distanceKm, b: target.distanceKm, format: (value) => `${Number(value).toFixed(2)}km` },
    { label: "평균 페이스", a: base.pace, b: target.pace, format: (value) => `${formatPace(value)}/km`, better: "min" },
    { label: "평균 심박", a: base.heartRate, b: target.heartRate, format: (value) => Number.isFinite(value) ? `${Math.round(value)}bpm` : "--" },
    { label: "케이던스", a: base.cadence, b: target.cadence, format: (value) => Number.isFinite(value) ? `${Math.round(value)}spm` : "--" },
  ];
  $("#runComparison").innerHTML = fields.map((field) => {
    const aBetter = field.better && Number.isFinite(field.a) && Number.isFinite(field.b) && (field.better === "min" ? field.a < field.b : field.a > field.b);
    const bBetter = field.better && Number.isFinite(field.a) && Number.isFinite(field.b) && (field.better === "min" ? field.b < field.a : field.b > field.a);
    return `<div class="comparison-row"><span>${field.label}</span><b class="${aBetter ? "better" : ""}">${field.format(field.a)}</b><b class="${bBetter ? "better" : ""}">${field.format(field.b)}</b></div>`;
  }).join("");
}

function exportRunnerData() {
  const payload = JSON.stringify({ app: "STRION", version: 1, exportedAt: new Date().toISOString(), profile: runnerProfile }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `strion-backup-${toDateInputValue(new Date())}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importRunnerData(event) {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = "";
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    const profile = backup?.profile;
    if (backup?.app !== "STRION" || !profile || !Array.isArray(profile.activities) || !Array.isArray(profile.workouts) || !Array.isArray(profile.races)) {
      throw new Error("올바른 STRION 백업 파일이 아닙니다.");
    }
    if (!window.confirm("현재 이 기기에 저장된 STRION 데이터를 백업 파일로 교체할까요?")) return;
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
    runnerProfile = loadRunnerProfile();
    renderPersonalHub();
    renderTrainingCenter();
    $("#maxHeartRateInput").value = runnerProfile.maxHeartRate || "";
    window.alert("STRION 데이터 복원이 완료되었습니다.");
  } catch (error) {
    window.alert(error.message || "백업 파일을 읽지 못했습니다.");
  }
}

function initializePwa() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js?v=20261024-3").catch(() => {});
  }
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
  if (isIos && !isStandalone) $("#installAppButton").classList.remove("hidden");
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $("#installAppButton").classList.remove("hidden");
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    $("#installAppButton").classList.add("hidden");
  });
}

async function installStrionApp() {
  if (!deferredInstallPrompt) {
    window.alert("iPhone/iPad에서는 Safari 공유 버튼을 누른 뒤 '홈 화면에 추가'를 선택해주세요.");
    return;
  }
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $("#installAppButton").classList.add("hidden");
}

async function analyzeFiles(files) {
  if (!files.length || files.some((file) => !file.name.toLowerCase().endsWith(".fit"))) {
    showError(".fit 확장자의 Garmin 활동 파일을 선택해주세요.");
    return;
  }

  setView(loadingView);
  try {
    const decodedActivities = [];
    for (const file of files) decodedActivities.push(await decodeFitFile(file));
    decodedActivities.forEach(saveActivitySummary);
    activity = decodedActivities.at(-1);
    renderDashboard(activity);
    if (decodedActivities.length > 1) {
      $("#fileName").textContent = `${decodedActivities.length}개 파일 · 최근 기록 표시`;
    }
    setView(dashboardView);
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    console.error(error);
    showError(error.message || "파일이 손상되었거나 지원하지 않는 FIT 파일입니다.");
  }
}

async function decodeFitFile(file) {
    const buffer = await file.arrayBuffer();
    const stream = Stream.fromArrayBuffer(buffer);
    const decoder = new Decoder(stream);
    if (!decoder.isFIT()) throw new Error("FIT 파일 헤더를 확인할 수 없습니다.");

    const { messages, errors } = decoder.read({
      convertDateTimesToDates: true,
      mergeHeartRates: true,
      includeUnknownData: true,
    });
    if (errors.length && !messages.recordMesgs?.length) throw errors[0];

    const decoded = normalizeActivity(messages, file);
    if (!decoded.records.length) throw new Error("시간별 활동 기록(record)을 찾지 못했습니다.");
    return decoded;
}

function normalizeActivity(messages, file) {
  const records = (messages.recordMesgs || [])
    .filter((record) => record.timestamp)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const session = messages.sessionMesgs?.[0] || {};
  const laps = messages.lapMesgs || [];
  const workout = messages.workoutMesgs?.[0] || {};
  const sessionZones = (messages.timeInZoneMesgs || []).find((zone) => zone.referenceMesg === "session") || null;
  const firstRecord = records[0] || {};
  const lastRecord = records.at(-1) || {};
  const startTime = asDate(session.startTime || firstRecord.timestamp);
  const endTime = asDate(session.timestamp || lastRecord.timestamp);
  const totalDistance = firstNumber(session.totalDistance, lastRecord.distance, 0);
  const totalTime = firstNumber(session.totalTimerTime, session.totalElapsedTime, secondsBetween(startTime, endTime));
  const averageSpeed = firstNumber(session.enhancedAvgSpeed, session.avgSpeed, totalDistance / totalTime);

  const points = records.map((record, index) => ({
    index,
    timestamp: asDate(record.timestamp),
    elapsed: secondsBetween(startTime, asDate(record.timestamp)),
    distance: numberOrNull(record.distance),
    speed: firstNullableNumber(record.enhancedSpeed, record.speed),
    heartRate: numberOrNull(record.heartRate),
    cadence: runningCadence(record.cadence),
    altitude: firstNullableNumber(record.enhancedAltitude, record.altitude),
    power: numberOrNull(record.power),
    temperature: numberOrNull(record.temperature),
    verticalOscillation: numberOrNull(record.verticalOscillation),
    stanceTime: firstNullableNumber(record.stanceTime, record.groundContactTime),
    stanceTimeBalance: numberOrNull(record.stanceTimeBalance),
    stepLength: firstNullableNumber(record.stepLength, record.strideLength),
    verticalRatio: numberOrNull(record.verticalRatio),
    respirationRate: firstNullableNumber(record.respirationRate, record.enhancedRespirationRate),
    latitude: semicirclesToDegrees(record.positionLat, true),
    longitude: semicirclesToDegrees(record.positionLong, false),
  }));

  return {
    fileName: file.name,
    fileSize: file.size,
    session,
    records,
    points,
    laps,
    startTime,
    endTime,
    totalDistance,
    totalTime,
    averageSpeed,
    averageHeartRate: firstNumber(session.avgHeartRate, average(points.map((p) => p.heartRate))),
    maxHeartRate: firstNumber(session.maxHeartRate, maximum(points.map((p) => p.heartRate))),
    averageCadence: firstNumber(runningCadence(session.avgRunningCadence), runningCadence(session.avgCadence), average(points.map((p) => p.cadence))),
    calories: firstNumber(session.totalCalories, 0),
    ascent: firstNumber(session.totalAscent, calculateAscent(points)),
    sport: session.subSport || session.sport || "running",
    workoutName: workout.wktName || "",
    sessionZones,
  };
}

function renderDashboard(data) {
  $("#fileName").textContent = data.fileName;
  $("#activityTitle").textContent = data.workoutName || `${formatDate(data.startTime)} 러닝`;
  $("#activityMeta").textContent = `STRIDE REVIEW / ${String(data.sport).toUpperCase()} / ${formatStartTime(data.startTime)}`;
  $("#maxHeartRateInput").value = runnerProfile.maxHeartRate || "";

  const summaries = [
    ["거리", `${(data.totalDistance / 1000).toFixed(2)}`, "km"],
    ["운동 시간", formatDuration(data.totalTime), ""],
    ["평균 페이스", formatPace(speedToPace(data.averageSpeed)), "/km"],
    ["평균 심박", roundOrDash(data.averageHeartRate), "bpm"],
    ["평균 케이던스", roundOrDash(data.averageCadence), "spm"],
    ["상승 고도", roundOrDash(data.ascent), "m"],
  ];
  $("#summaryGrid").innerHTML = summaries.map(([label, value, unit]) => `
    <article class="summary-card"><span>${label}</span><strong>${value}</strong><small>${unit}</small></article>
  `).join("");

  renderInsight(data);
  renderRunScore(data);
  renderVdotCoach(data);
  renderTimeline("pace");
  renderSplits(data);
  renderHeartRateZones(data);
  renderRoute(data);
  renderDynamics(data);
}

function renderInsight(data) {
  const firstHalf = segmentAveragePace(data.points, 0, 0.5);
  const secondHalf = segmentAveragePace(data.points, 0.5, 1);
  const paceDifference = firstHalf && secondHalf ? secondHalf - firstHalf : null;
  let title = "안정적인 러닝 기록입니다.";
  let text = `총 ${(data.totalDistance / 1000).toFixed(2)}km를 평균 ${formatPace(speedToPace(data.averageSpeed))}/km로 달렸습니다.`;
  let badge = "STEADY";

  const fastKilometerLaps = data.laps.filter((lap) => lap.totalDistance >= 950 && lap.totalDistance <= 1050 && (lap.enhancedAvgSpeed || lap.avgSpeed) >= 3.6);

  if (data.workoutName && fastKilometerLaps.length >= 2) {
    const paces = fastKilometerLaps.map((lap) => firstNumber(lap.totalTimerTime, lap.totalElapsedTime));
    const fastest = Math.min(...paces);
    const slowest = Math.max(...paces);
    title = `${fastKilometerLaps.length}회의 1km 인터벌을 완료했습니다.`;
    text = `질주 구간은 ${formatPace(fastest)}–${formatPace(slowest)}/km 범위입니다. 목표 훈련명 “${data.workoutName}”과 각 반복의 심박 회복을 함께 비교해보세요.`;
    badge = "WORKOUT DONE";
  } else if (paceDifference !== null && paceDifference < -5) {
    title = "후반에 더 빠르게 달렸습니다.";
    text = `후반 평균 페이스가 전반보다 약 ${Math.abs(Math.round(paceDifference))}초/km 빨랐습니다. 여유를 남겨두고 잘 끌어올린 네거티브 스플릿입니다.`;
    badge = "STRONG FINISH";
  } else if (paceDifference !== null && paceDifference > 12) {
    title = "후반 페이스가 다소 떨어졌습니다.";
    text = `후반 평균 페이스가 전반보다 약 ${Math.round(paceDifference)}초/km 느렸습니다. 초반 속도와 보급·기온의 영향을 함께 확인해보세요.`;
    badge = "FADE CHECK";
  } else if (data.averageHeartRate) {
    text += ` 평균 심박은 ${Math.round(data.averageHeartRate)}bpm이며, 큰 페이스 변화 없이 리듬을 유지했습니다.`;
  }

  $("#insightTitle").textContent = title;
  $("#insightText").textContent = text;
  $("#effortBadge").textContent = badge;
}

function calculateRunScore(data) {
  const activePaces = data.points
    .map((point) => speedToPace(point.speed))
    .filter((pace) => Number.isFinite(pace) && pace >= 150 && pace <= 1200);
  const paceMean = average(activePaces);
  const paceDeviation = standardDeviation(activePaces, paceMean);
  const paceCv = paceMean ? paceDeviation / paceMean : null;
  const paceScore = Number.isFinite(paceCv) ? clamp(100 - paceCv * 420, 35, 100) : 65;

  const firstPace = segmentAveragePace(data.points, 0, .5);
  const secondPace = segmentAveragePace(data.points, .5, 1);
  const finishDelta = firstPace && secondPace ? (secondPace - firstPace) / firstPace : 0;
  const finishScore = clamp(92 - Math.max(0, finishDelta) * 350 + Math.max(0, -finishDelta) * 80, 40, 100);

  const heartPoints = data.points.filter((point) => Number.isFinite(point.heartRate));
  const halfIndex = Math.floor(heartPoints.length / 2);
  const firstHeart = average(heartPoints.slice(0, halfIndex).map((point) => point.heartRate));
  const secondHeart = average(heartPoints.slice(halfIndex).map((point) => point.heartRate));
  const heartDrift = firstHeart ? (secondHeart - firstHeart) / firstHeart : null;
  const heartScore = Number.isFinite(heartDrift) ? clamp(100 - Math.max(0, heartDrift) * 420, 45, 100) : 70;

  const cadences = data.points.map((point) => point.cadence).filter(Number.isFinite);
  const cadenceMean = average(cadences);
  const cadenceCv = cadenceMean ? standardDeviation(cadences, cadenceMean) / cadenceMean : null;
  const cadenceScore = Number.isFinite(cadenceCv) ? clamp(100 - cadenceCv * 500, 45, 100) : 70;
  const total = Math.round(paceScore * .45 + finishScore * .25 + heartScore * .18 + cadenceScore * .12);

  return {
    total,
    pace: Math.round(paceScore),
    finish: Math.round(finishScore),
    heart: Math.round(heartScore),
    cadence: Math.round(cadenceScore),
  };
}

function renderRunScore(data) {
  const score = calculateRunScore(data);
  const labels = score.total >= 90
    ? ["탁월한 리듬", "페이스와 후반 유지력이 매우 안정적입니다."]
    : score.total >= 80
      ? ["안정적인 러닝", "전체 흐름이 고르게 유지된 좋은 러닝입니다."]
      : score.total >= 70
        ? ["균형 잡힌 러닝", "일부 변동은 있지만 전반적인 흐름은 양호합니다."]
        : ["회복 포인트 확인", "초반 속도와 후반 유지력, 심박 변화를 함께 살펴보세요."];
  $("#runScoreValue").textContent = score.total;
  $(".run-score-gauge").style.setProperty("--score-angle", `${score.total * 3.6}deg`);
  $("#runScoreTitle").textContent = labels[0];
  $("#runScoreDescription").textContent = `${labels[1]} 이 점수는 훈련 일관성을 설명하는 참고 지표입니다.`;
  $("#runScoreMetrics").innerHTML = [
    ["페이스 안정성", score.pace],
    ["후반 유지력", score.finish],
    ["심박 안정성", score.heart],
    ["케이던스 안정성", score.cadence],
  ].map(([label, value]) => `<article class="score-metric"><span>${label}</span><strong>${value}</strong></article>`).join("");
}

function renderVdotCoach(data) {
  const pbDistances = { "5k": 5, "10k": 10, half: 21.0975, full: 42.195 };
  const candidates = Object.entries(pbDistances).map(([key, distance]) => {
    const value = runnerProfile.pbs[key];
    const seconds = value ? parseClockTime(value) : 0;
    return seconds > 0 ? { key, distance, seconds, vdot: estimateVdot(distance, seconds) } : null;
  }).filter(Boolean).filter((item) => Number.isFinite(item.vdot));

  if (!candidates.length) {
    $("#vdotScore").textContent = "--";
    $("#vdotEmpty").classList.remove("hidden");
    $("#vdotCoachContent").classList.add("hidden");
    return;
  }

  const base = candidates.sort((a, b) => b.vdot - a.vdot)[0];
  const vdot = base.vdot;
  const zones = [
    { code: "E", label: "이지", low: .59, high: .74 },
    { code: "M", label: "마라톤", low: .75, high: .84 },
    { code: "T", label: "역치", low: .83, high: .88 },
    { code: "I", label: "인터벌", low: .95, high: 1 },
    { code: "R", label: "반복주", low: 1.05, high: 1.1 },
  ].map((zone) => ({
    ...zone,
    slow: paceForVdot(vdot, zone.low),
    fast: paceForVdot(vdot, zone.high),
  }));

  $("#vdotScore").textContent = vdot.toFixed(1);
  $("#vdotEmpty").classList.add("hidden");
  $("#vdotCoachContent").classList.remove("hidden");
  $("#trainingPaceGrid").innerHTML = zones.map((zone) => `
    <article class="training-pace-card"><span>${zone.code} · ${zone.label}</span><b>${formatPace(zone.fast)}–${formatPace(zone.slow)}/km</b></article>
  `).join("");

  const intervalLaps = data.laps.filter((lap) => lap.totalDistance >= 800 && lap.totalDistance <= 1200 && firstNumber(lap.totalTimerTime, lap.totalElapsedTime) > 0);
  const analyzedPace = intervalLaps.length >= 2
    ? average(intervalLaps.map((lap) => firstNumber(lap.totalTimerTime, lap.totalElapsedTime) / (firstNumber(lap.totalDistance, 1000) / 1000)))
    : speedToPace(data.averageSpeed);
  const matchingZone = zones.find((zone) => analyzedPace >= zone.fast * .97 && analyzedPace <= zone.slow * 1.03);
  const baseLabel = `${distanceLabel(base.distance)} PB ${runnerProfile.pbs[base.key]} 기준`;

  if (intervalLaps.length >= 2) {
    $("#coachVerdictTitle").textContent = `${intervalLaps.length}회 반복 구간 분석`;
    $("#coachVerdictText").textContent = `${baseLabel} 추정 VDOT ${vdot.toFixed(1)}입니다. 반복 구간 평균은 ${formatPace(analyzedPace)}/km로 ${matchingZone ? `${matchingZone.code}·${matchingZone.label} 강도에 가깝습니다` : "권장 강도 범위 밖에 있습니다"}. 마지막 반복까지 편차가 작고 회복 구간 심박이 내려오는지 함께 확인하세요.`;
  } else {
    $("#coachVerdictTitle").textContent = matchingZone ? `${matchingZone.code}·${matchingZone.label} 강도에 가까운 러닝` : "훈련 강도 범위를 확인하세요";
    $("#coachVerdictText").textContent = `${baseLabel} 추정 VDOT ${vdot.toFixed(1)}입니다. 이번 평균 페이스 ${formatPace(analyzedPace)}/km는 ${matchingZone ? `${matchingZone.label} 참고 범위에 포함됩니다` : "표준 E·M·T·I·R 참고 범위와 차이가 있습니다"}. 평균 페이스에는 정지·워밍업·쿨다운이 섞일 수 있으므로 구간 그래프와 함께 판단하세요.`;
  }
}

function estimateVdot(distanceKm, seconds) {
  const minutes = seconds / 60;
  const velocity = distanceKm * 1000 / minutes;
  const oxygenCost = -4.6 + .182258 * velocity + .000104 * velocity * velocity;
  const sustainableFraction = .8 + .1894393 * Math.exp(-.012778 * minutes) + .2989558 * Math.exp(-.1932605 * minutes);
  return oxygenCost / sustainableFraction;
}

function paceForVdot(vdot, fraction) {
  const targetOxygen = vdot * fraction;
  const a = .000104;
  const b = .182258;
  const c = -(targetOxygen + 4.6);
  const velocity = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  return velocity > 0 ? 60000 / velocity : null;
}

function renderTimeline(key) {
  const config = chartConfig[key];
  const sampled = samplePoints(activity.points, 700);
  const values = sampled.map((point) => key === "pace" ? speedToPace(point.speed) : point[key]);
  const labels = sampled.map((point) => point.elapsed / 60);

  timelineChart?.destroy();
  timelineChart = new Chart($("#timelineChart"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: config.label,
        data: values,
        borderColor: config.color,
        backgroundColor: `${config.color}18`,
        borderWidth: 2.2,
        pointRadius: 0,
        fill: true,
        tension: 0.22,
        spanGaps: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: (items) => `${Math.round(items[0].parsed.x)}분 지점`,
            label: (item) => key === "pace" ? `${formatPace(item.parsed.y)} /km` : `${Math.round(item.parsed.y * 10) / 10} ${config.unit}`,
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          title: { display: true, text: "경과 시간 (분)" },
          grid: { color: "#cfcec555" },
        },
        y: {
          reverse: Boolean(config.reverse),
          grid: { color: "#cfcec588" },
          ticks: { callback: (value) => key === "pace" ? formatPace(value) : value },
        },
      },
    },
  });
}

function renderSplits(data) {
  const computed = data.laps.length ? data.laps.map(lapToSplit) : computeKilometerSplits(data.points);
  $("#splitsBody").innerHTML = computed.length ? computed.map((split, index) => `
    <tr>
      <td>${index + 1}${split.partial ? "*" : ""} km</td>
      <td>${formatPace(split.pace)} /km</td>
      <td>${roundOrDash(split.heartRate)} bpm</td>
      <td>${formatSigned(split.elevation)} m</td>
    </tr>
  `).join("") : `<tr><td colspan="4">구간 데이터를 찾지 못했습니다.</td></tr>`;
}

function renderHeartRateZones(data) {
  const customMaxHr = Number($("#maxHeartRateInput").value);
  const heartRatePoints = data.points.filter((point) => point.heartRate && point.elapsed >= 0);
  if (customMaxHr >= 100 && customMaxHr <= 240 && heartRatePoints.length) {
    renderCalculatedHeartRateZones(heartRatePoints, customMaxHr, "입력한 최대 심박 기준 · Z1 50%부터 Z5 100%까지");
    return;
  }

  if (Array.isArray(data.sessionZones?.timeInHrZone)) {
    const zoneSeconds = data.sessionZones.timeInHrZone.slice(1, 6);
    const boundaries = data.sessionZones.hrZoneHighBoundary || [];
    const colors = ["#9eb7ae", "#55a884", "#d7c62e", "#ff842f", "#d93624"];
    const total = zoneSeconds.reduce((sum, value) => sum + (Number(value) || 0), 0) || 1;
    $("#heartRateZones").innerHTML = zoneSeconds.map((value, index) => {
      const lower = boundaries[index] ?? "?";
      const upper = boundaries[index + 1] ?? "+";
      return `
        <div class="zone-row" title="${lower}–${upper} bpm">
          <span class="zone-name">Z${index + 1}</span>
          <span class="zone-range">${lower}–${upper} bpm</span>
          <div class="zone-track"><div class="zone-fill" style="width:${((Number(value) || 0) / total) * 100}%;background:${colors[index]}"></div></div>
          <span class="zone-time">${formatShortDuration(Number(value) || 0)}</span>
        </div>
      `;
    }).join("");
    $("#zoneBasis").textContent = "FIT 파일에 저장된 Garmin 심박 존 기준입니다. 최대 심박을 입력하면 다시 계산합니다.";
    return;
  }

  if (!heartRatePoints.length) {
    $("#heartRateZones").innerHTML = "<p>심박 데이터가 이 FIT 파일에 없습니다.</p>";
    $("#zoneBasis").textContent = "최대 심박을 입력해도 FIT 심박 데이터가 있어야 분포를 계산할 수 있습니다.";
    return;
  }

  const maxHr = Math.max(data.maxHeartRate || 0, ...heartRatePoints.map((point) => point.heartRate));
  renderCalculatedHeartRateZones(heartRatePoints, maxHr, `이 활동에서 관측된 최고 심박 ${Math.round(maxHr)} bpm을 임시 기준으로 계산했습니다.`);
}

function renderCalculatedHeartRateZones(heartRatePoints, maxHr, basisText) {
  const thresholds = [0.6, 0.7, 0.8, 0.9, 1.01];
  const lowerPercentages = [0.5, 0.6, 0.7, 0.8, 0.9];
  const upperPercentages = [0.6, 0.7, 0.8, 0.9, 1];
  const colors = ["#9eb7ae", "#55a884", "#d7c62e", "#ff842f", "#d93624"];
  const seconds = [0, 0, 0, 0, 0];
  for (let index = 1; index < heartRatePoints.length; index += 1) {
    const point = heartRatePoints[index];
    const previous = heartRatePoints[index - 1];
    const delta = Math.min(10, Math.max(0, point.elapsed - previous.elapsed));
    const ratio = point.heartRate / maxHr;
    const foundZone = thresholds.findIndex((limit) => ratio < limit);
    const zone = foundZone === -1 ? 4 : foundZone;
    seconds[Math.max(0, zone)] += delta;
  }
  const total = seconds.reduce((sum, value) => sum + value, 0) || 1;
  $("#heartRateZones").innerHTML = seconds.map((value, index) => `
    <div class="zone-row">
      <span class="zone-name">Z${index + 1}</span>
      <span class="zone-range">${Math.round(maxHr * lowerPercentages[index])}–${index === 4 ? Math.round(maxHr) : Math.round(maxHr * upperPercentages[index]) - 1} bpm</span>
      <div class="zone-track"><div class="zone-fill" style="width:${(value / total) * 100}%;background:${colors[index]}"></div></div>
      <span class="zone-time">${formatShortDuration(value)}</span>
    </div>
  `).join("");
  $("#zoneBasis").textContent = basisText;
}

function renderRoute(data) {
  const route = data.points.filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
  const panel = $("#routePanel");
  if (route.length < 2) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  const sampled = samplePoints(route, 900);
  const averageLatitude = average(sampled.map((point) => point.latitude));
  const longitudeScale = Math.cos(averageLatitude * Math.PI / 180);
  const coordinates = sampled.map((point) => ({ x: point.longitude * longitudeScale, y: point.latitude }));
  const minX = Math.min(...coordinates.map((point) => point.x));
  const maxX = Math.max(...coordinates.map((point) => point.x));
  const minY = Math.min(...coordinates.map((point) => point.y));
  const maxY = Math.max(...coordinates.map((point) => point.y));
  const width = Math.max(maxX - minX, 1e-9);
  const height = Math.max(maxY - minY, 1e-9);
  const scale = Math.min(880 / width, 480 / height);
  const offsetX = (1000 - width * scale) / 2;
  const offsetY = (600 - height * scale) / 2;
  const projected = coordinates.map((point) => ({
    x: offsetX + (point.x - minX) * scale,
    y: 600 - (offsetY + (point.y - minY) * scale),
  }));
  const points = projected.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const start = projected[0];
  const finish = projected.at(-1);
  const grid = [200, 400, 600, 800].map((x) => `<line class="route-grid-line" x1="${x}" y1="0" x2="${x}" y2="600"/>`).join("")
    + [150, 300, 450].map((y) => `<line class="route-grid-line" x1="0" y1="${y}" x2="1000" y2="${y}"/>`).join("");
  $("#routeMap").innerHTML = `<svg viewBox="0 0 1000 600" role="img" aria-label="러닝 GPS 경로"><g>${grid}</g><polyline class="route-shape" points="${points}"/><circle class="route-start" cx="${start.x}" cy="${start.y}" r="11"/><circle class="route-finish" cx="${finish.x}" cy="${finish.y}" r="11"/><text class="route-label" x="20" y="35">START ●  /  FINISH ●</text></svg>`;
}

function renderDynamics(data) {
  dynamicsCharts.forEach((chart) => chart.destroy());
  dynamicsCharts = [];
  const flowFields = [
    { key: "verticalOscillation", label: "수직 진폭", unit: "cm", decimals: 1, transform: (value) => value / 10, color: "#ff3df2" },
    { key: "verticalRatio", label: "수직 비율", unit: "%", decimals: 1, transform: (value) => value, color: "#6d4b28" },
    { key: "stepLength", label: "보폭", unit: "m", decimals: 2, transform: (value) => value / 1000, color: "#5978ff" },
    { key: "cadence", label: "케이던스", unit: "spm", decimals: 0, transform: (value) => value, color: "#50ecff" },
  ].map((field) => {
    const points = data.points
      .filter((point) => Number.isFinite(point[field.key]))
      .map((point) => ({ x: point.elapsed / 60, y: field.transform(point[field.key]) }));
    return { ...field, points, value: average(points.map((point) => point.y)) };
  }).filter((field) => field.points.length);

  const fields = [
    ["파워", average(data.points.map((p) => p.power)), "W", 0],
    ["지면 접촉 시간", average(data.points.map((p) => p.stanceTime)), "ms", 0],
    ["좌우 균형", average(data.points.map((p) => p.stanceTimeBalance)), "%", 1],
    ["호흡수", average(data.points.map((p) => p.respirationRate)), "brpm", 1],
    ["기온", average(data.points.map((p) => p.temperature)), "°C", 1],
  ].filter(([, value]) => Number.isFinite(value));
  const panel = $("#dynamicsPanel");
  if (!fields.length && !flowFields.length) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  $("#dynamicsCharts").innerHTML = flowFields.map((field, index) => `
    <article class="dynamic-flow-card">
      <div class="dynamic-flow-heading"><span>${field.label} 흐름</span><strong>${field.value.toFixed(field.decimals)}<small>${field.unit}</small></strong></div>
      <div class="dynamic-mini-chart"><canvas id="dynamicFlowChart${index}"></canvas></div>
    </article>
  `).join("");
  $("#dynamicsGrid").innerHTML = fields.map(([label, value, unit, decimals]) => `
    <article class="dynamic-card"><span>${label}</span><strong>${Number(value).toFixed(decimals)} <small>${unit}</small></strong></article>
  `).join("");

  if (typeof Chart === "undefined") return;
  flowFields.forEach((field, index) => {
    const sampled = samplePoints(field.points, 350);
    dynamicsCharts.push(new Chart($(`#dynamicFlowChart${index}`), {
      type: "line",
      data: { datasets: [{ data: sampled, borderColor: field.color, backgroundColor: `${field.color}18`, borderWidth: 1.8, pointRadius: 0, fill: true, tension: .2, spanGaps: true }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: "nearest" },
        plugins: {
          legend: { display: false },
          tooltip: { displayColors: false, callbacks: { title: (items) => `${Math.round(items[0].parsed.x)}분 지점`, label: (item) => `${item.parsed.y.toFixed(field.decimals)} ${field.unit}` } },
        },
        scales: {
          x: { type: "linear", ticks: { color: "#85867f", maxTicksLimit: 5, callback: (value) => `${value}분` }, grid: { display: false } },
          y: { ticks: { color: "#85867f", maxTicksLimit: 4 }, grid: { color: "#cfcec566" } },
        },
      },
    }));
  });
}

function computeKilometerSplits(points) {
  const usable = points.filter((point) => Number.isFinite(point.distance));
  if (usable.length < 2) return [];
  const splits = [];
  let start = usable[0];
  let target = Math.floor(start.distance / 1000 + 1) * 1000;
  let bucket = [];
  for (const point of usable) {
    bucket.push(point);
    if (point.distance >= target) {
      splits.push(splitFromPoints(start, point, bucket, false));
      start = point;
      bucket = [];
      target += 1000;
    }
  }
  if (bucket.length && usable.at(-1).distance - start.distance > 200) {
    splits.push(splitFromPoints(start, usable.at(-1), bucket, true));
  }
  return splits;
}

function splitFromPoints(start, end, points, partial) {
  const distanceKm = Math.max((end.distance - start.distance) / 1000, 0.01);
  return {
    pace: (end.elapsed - start.elapsed) / distanceKm,
    heartRate: average(points.map((point) => point.heartRate)),
    elevation: Number.isFinite(start.altitude) && Number.isFinite(end.altitude) ? end.altitude - start.altitude : null,
    partial,
  };
}

function lapToSplit(lap) {
  const seconds = firstNumber(lap.totalTimerTime, lap.totalElapsedTime, 0);
  const distanceKm = firstNumber(lap.totalDistance, 1000) / 1000;
  return {
    pace: seconds / Math.max(distanceKm, 0.01),
    heartRate: firstNullableNumber(lap.avgHeartRate),
    elevation: firstNullableNumber(lap.totalAscent),
    partial: distanceKm < 0.95,
  };
}

function segmentAveragePace(points, startRatio, endRatio) {
  const usable = points.filter((point) => Number.isFinite(point.distance));
  if (usable.length < 2) return null;
  const maxDistance = usable.at(-1).distance;
  const segment = usable.filter((point) => point.distance >= maxDistance * startRatio && point.distance <= maxDistance * endRatio);
  if (segment.length < 2) return null;
  const distanceKm = (segment.at(-1).distance - segment[0].distance) / 1000;
  return (segment.at(-1).elapsed - segment[0].elapsed) / distanceKm;
}

function calculateAscent(points) {
  let ascent = 0;
  let previous = null;
  for (const point of points) {
    if (!Number.isFinite(point.altitude)) continue;
    if (previous !== null && point.altitude > previous && point.altitude - previous < 15) ascent += point.altitude - previous;
    previous = point.altitude;
  }
  return ascent;
}

function samplePoints(points, maximum) {
  if (points.length <= maximum) return points;
  const step = Math.ceil(points.length / maximum);
  return points.filter((_, index) => index % step === 0 || index === points.length - 1);
}

function resetDashboard() {
  activity = null;
  fileInput.value = "";
  timelineChart?.destroy();
  timelineChart = null;
  dynamicsCharts.forEach((chart) => chart.destroy());
  dynamicsCharts = [];
  setView(uploadView);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showError(message) {
  $("#errorMessage").textContent = message;
  setView(errorView);
}

function semicirclesToDegrees(value, latitude) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const limit = latitude ? 90 : 180;
  if (Math.abs(number) <= limit) return number;
  return number * (180 / 2147483648);
}

function speedToPace(speed) {
  const number = Number(speed);
  return Number.isFinite(number) && number > 0.3 ? 1000 / number : null;
}

function runningCadence(value) {
  const cadence = numberOrNull(value);
  if (cadence === null) return null;
  return cadence > 0 && cadence < 130 ? cadence * 2 : cadence;
}

function formatPace(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) return "--:--";
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "--:--";
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function formatShortDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
}

function formatDate(date) {
  return new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric" }).format(date);
}

function formatStartTime(date) {
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatSigned(value) {
  if (!Number.isFinite(value)) return "--";
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function startOfLocalDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }

function startOfWeek(date) {
  const day = startOfLocalDay(date);
  const offset = day.getDay() === 0 ? -6 : 1 - day.getDay();
  day.setDate(day.getDate() + offset);
  return day;
}

function toDateInputValue(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function dateFromInput(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatCompactDate(value) {
  const date = typeof value === "string" ? dateFromInput(value) : value;
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", weekday: "short" }).format(date);
}

function daysUntil(dateString, today = startOfLocalDay(new Date())) {
  const [year, month, day] = dateString.split("-").map(Number);
  const raceDate = new Date(year, month - 1, day);
  return Math.round((raceDate - today) / 86400000);
}

function formatRaceDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(new Date(year, month - 1, day));
}

function distanceLabel(distance) {
  const value = Number(distance);
  if (value === 21.0975) return "HALF";
  if (value === 42.195) return "FULL";
  return `${value}K`;
}

function parseClockTime(value) {
  const parts = value.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
}

function normalizeClockTime(value) {
  const seconds = parseClockTime(value);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function secondsBetween(start, end) { return Math.max(0, (end - start) / 1000); }
function numberOrNull(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function firstNullableNumber(...values) { return values.map(numberOrNull).find((value) => value !== null) ?? null; }
function firstNumber(...values) { return firstNullableNumber(...values) ?? 0; }
function average(values) { const valid = values.filter(Number.isFinite); return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null; }
function standardDeviation(values, mean = average(values)) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length || !Number.isFinite(mean)) return null;
  return Math.sqrt(valid.reduce((sum, value) => sum + (value - mean) ** 2, 0) / valid.length);
}
function clamp(value, minimum, maximumValue) { return Math.min(maximumValue, Math.max(minimum, value)); }
function divideOrNull(value, divisor) { return Number.isFinite(value) ? value / divisor : null; }
function maximum(values) { const valid = values.filter(Number.isFinite); return valid.length ? Math.max(...valid) : null; }
function roundOrDash(value) { return Number.isFinite(value) ? String(Math.round(value)) : "--"; }
