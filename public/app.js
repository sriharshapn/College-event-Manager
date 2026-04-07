const state = {
  user: null,
  events: [],
  registrations: [],
  overview: null,
  scanner: null,
  lastScanAt: 0
};

const authSection = document.getElementById("authSection");
const dashboardSection = document.getElementById("dashboardSection");
const studentPanel = document.getElementById("studentPanel");
const adminPanel = document.getElementById("adminPanel");
const userBadge = document.getElementById("userBadge");
const logoutBtn = document.getElementById("logoutBtn");
const dashboardHeading = document.getElementById("dashboardHeading");
const dashboardDescription = document.getElementById("dashboardDescription");
const eventsList = document.getElementById("eventsList");
const adminEventsList = document.getElementById("adminEventsList");
const registrationList = document.getElementById("registrationList");
const statsGrid = document.getElementById("statsGrid");
const recentActivity = document.getElementById("recentActivity");
const scanResult = document.getElementById("scanResult");
const manualTokenInput = document.getElementById("manualTokenInput");
const toast = document.getElementById("toast");

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  toast.style.background = isError ? "#7f1d1d" : "#1f2937";
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.add("hidden"), 2800);
}

function formatDate(date, time) {
  const value = new Date(`${date}T${time}`);
  return value.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function renderApp() {
  const authenticated = Boolean(state.user);
  authSection.classList.toggle("hidden", authenticated);
  dashboardSection.classList.toggle("hidden", !authenticated);
  userBadge.classList.toggle("hidden", !authenticated);
  logoutBtn.classList.toggle("hidden", !authenticated);

  if (!authenticated) {
    stopScanner();
    return;
  }

  userBadge.textContent = `${state.user.name} · ${state.user.role}`;
  dashboardHeading.textContent = state.user.role === "admin" ? "Admin Control Room" : "Student Event Space";
  dashboardDescription.textContent =
    state.user.role === "admin"
      ? "Create and manage college events, watch registrations, and scan QR codes to mark attendance."
      : "Explore campus events, register instantly, and carry your QR pass for faster check-in.";

  studentPanel.classList.toggle("hidden", state.user.role !== "student");
  adminPanel.classList.toggle("hidden", state.user.role !== "admin");

  renderEvents();
  renderRegistrations();
  renderOverview();

  if (state.user.role === "admin") {
    startScanner();
  } else {
    stopScanner();
  }
}

function renderEvents() {
  const target = state.user?.role === "admin" ? adminEventsList : eventsList;
  if (!target) {
    return;
  }

  if (!state.events.length) {
    target.innerHTML = '<div class="event-card"><p class="muted">No events found yet.</p></div>';
    return;
  }

  target.innerHTML = state.events
    .map((event) => {
      const action =
        state.user.role === "student"
          ? event.isRegistered
            ? `<span class="pill">Registered</span>`
            : `<button data-register="${event.id}">Register</button>`
          : `<span class="pill">${event.registrationCount} registered</span>`;

      const attendance =
        state.user.role === "admin"
          ? `<span class="pill warn">${event.seatsLeft} seats left</span>`
          : event.attendanceMarked
            ? `<span class="pill">Attendance marked</span>`
            : "";

      return `
        <article class="event-card">
          <header>
            <div>
              <h3>${event.title}</h3>
              <p class="muted">${event.description}</p>
            </div>
            ${attendance}
          </header>
          <div class="meta">
            <div><strong>When</strong>${formatDate(event.date, event.time)}</div>
            <div><strong>Where</strong>${event.location}</div>
            <div><strong>Capacity</strong>${event.capacity}</div>
            <div><strong>Registered</strong>${event.registrationCount}</div>
          </div>
          ${action}
        </article>
      `;
    })
    .join("");
}

function renderRegistrations() {
  if (!registrationList) {
    return;
  }

  if (state.user?.role !== "student") {
    registrationList.innerHTML = "";
    return;
  }

  if (!state.registrations.length) {
    registrationList.innerHTML = '<div class="registration-card"><p class="muted">No registrations yet.</p></div>';
    return;
  }

  registrationList.innerHTML = state.registrations
    .map(
      (registration) => `
        <article class="registration-card">
          <header>
            <div>
              <h3>${registration.event.title}</h3>
              <p class="muted">${formatDate(registration.event.date, registration.event.time)} · ${registration.event.location}</p>
            </div>
            <span class="pill ${registration.status === "attended" ? "" : "warn"}">${registration.status}</span>
          </header>
          <img class="qr-image" src="${registration.qrCodeDataUrl}" alt="QR code for ${registration.event.title}" />
          <p><strong>QR Token:</strong> ${registration.qrToken}</p>
          <p class="muted">Show this QR code at the event desk to mark attendance.</p>
        </article>
      `
    )
    .join("");
}

function renderOverview() {
  if (state.user?.role !== "admin" || !state.overview) {
    statsGrid.innerHTML = "";
    recentActivity.innerHTML = "";
    return;
  }

  const { stats, recentRegistrations } = state.overview;
  statsGrid.innerHTML = [
    ["Events", stats.totalEvents],
    ["Students", stats.totalStudents],
    ["Registrations", stats.totalRegistrations],
    ["Attendance", stats.attendanceCount]
  ]
    .map(
      ([label, value]) => `
        <div class="stat-card">
          <span>${label}</span>
          <strong>${value}</strong>
        </div>
      `
    )
    .join("");

  recentActivity.innerHTML = recentRegistrations.length
    ? recentRegistrations
        .map(
          (item) => `
            <div class="activity-item">
              <strong>${item.studentName}</strong> registered for <strong>${item.eventTitle}</strong>
              <div class="muted">${new Date(item.registeredAt).toLocaleString()} · Status: ${item.status}</div>
            </div>
          `
        )
        .join("")
    : '<div class="activity-item"><p class="muted">No activity yet.</p></div>';
}

async function loadSession() {
  const data = await api("/api/auth/session");
  state.user = data.user;
}

async function loadEvents() {
  if (!state.user) {
    return;
  }
  const data = await api("/api/events");
  state.events = data.events;
}

async function loadRegistrations() {
  if (state.user?.role !== "student") {
    state.registrations = [];
    return;
  }
  const data = await api("/api/my/registrations");
  state.registrations = data.registrations;
}

async function loadOverview() {
  if (state.user?.role !== "admin") {
    state.overview = null;
    return;
  }
  const data = await api("/api/admin/overview");
  state.overview = data;
}

async function refreshDashboard() {
  await loadSession();
  if (state.user) {
    await Promise.all([loadEvents(), loadRegistrations(), loadOverview()]);
  } else {
    state.events = [];
    state.registrations = [];
    state.overview = null;
  }
  renderApp();
}

document.getElementById("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(form.entries()))
    });
    formElement.reset();
    await refreshDashboard();
    showToast("Login successful.");
  } catch (error) {
    showToast(error.message, true);
  }
});

document.getElementById("registerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(form.entries()))
    });
    formElement.reset();
    await refreshDashboard();
    showToast("Student account created.");
  } catch (error) {
    showToast(error.message, true);
  }
});

logoutBtn.addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  state.user = null;
  renderApp();
  showToast("Logged out.");
});

document.getElementById("eventForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const payload = Object.fromEntries(form.entries());
  payload.capacity = Number(payload.capacity);

  try {
    await api("/api/events", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    formElement.reset();
    await refreshDashboard();
    showToast("Event created.");
  } catch (error) {
    showToast(error.message, true);
  }
});

document.body.addEventListener("click", async (event) => {
  const registerButton = event.target.closest("[data-register]");
  if (!registerButton) {
    return;
  }

  try {
    await api(`/api/events/${registerButton.dataset.register}/register`, {
      method: "POST"
    });
    await refreshDashboard();
    showToast("Registration confirmed. Your QR pass is ready.");
  } catch (error) {
    showToast(error.message, true);
  }
});

async function markAttendance(qrToken) {
  if (!qrToken) {
    showToast("Enter or scan a QR token.", true);
    return;
  }

  try {
    const data = await api("/api/attendance/scan", {
      method: "POST",
      body: JSON.stringify({ qrToken })
    });
    const prefix = data.alreadyMarked ? "Already marked" : "Attendance marked";
    scanResult.textContent = `${prefix}: ${data.registration.studentName} · ${data.registration.eventTitle}`;
    await refreshDashboard();
    showToast(scanResult.textContent);
  } catch (error) {
    scanResult.textContent = error.message;
    showToast(error.message, true);
  }
}

document.getElementById("manualMarkBtn").addEventListener("click", async () => {
  const token = manualTokenInput.value.trim();
  if (!token) {
    return;
  }
  await markAttendance(token);
  manualTokenInput.value = "";
});

async function startScanner() {
  if (state.scanner || typeof Html5Qrcode === "undefined") {
    if (typeof Html5Qrcode === "undefined") {
      scanResult.textContent = "QR scanner library is still loading.";
    }
    return;
  }

  state.scanner = new Html5Qrcode("qr-reader");

  try {
    await state.scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      async (decodedText) => {
        const now = Date.now();
        if (now - state.lastScanAt < 2000) {
          return;
        }
        state.lastScanAt = now;
        await markAttendance(decodedText);
      }
    );
    scanResult.textContent = "Scanner live. Point the camera at a student QR code.";
  } catch (error) {
    scanResult.textContent = "Camera access was blocked. Use manual token entry if needed.";
  }
}

async function stopScanner() {
  if (!state.scanner) {
    return;
  }
  try {
    await state.scanner.stop();
    await state.scanner.clear();
  } catch {
    // Ignore scanner shutdown issues.
  }
  state.scanner = null;
}

refreshDashboard().catch((error) => {
  showToast(error.message, true);
});
