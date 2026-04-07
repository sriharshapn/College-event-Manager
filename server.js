const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "db.json");
const AUTH_COOKIE = "campus_session";
const TOKEN_SECRET = process.env.TOKEN_SECRET || "change-this-secret-before-production";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, originalHash] = storedHash.split(":");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(originalHash, "hex"));
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    const now = new Date().toISOString();
    const seed = {
      users: [
        {
          id: crypto.randomUUID(),
          name: "Campus Admin",
          email: "admin@college.local",
          passwordHash: hashPassword("admin123"),
          role: "admin",
          createdAt: now
        },
        {
          id: crypto.randomUUID(),
          name: "Demo Student",
          email: "student@college.local",
          passwordHash: hashPassword("student123"),
          role: "student",
          createdAt: now
        }
      ],
      events: [
        {
          id: crypto.randomUUID(),
          title: "Innovation Expo 2026",
          description: "A campus showcase for projects, startups, robotics demos, and student-led workshops.",
          location: "Main Auditorium",
          date: "2026-04-18",
          time: "10:00",
          capacity: 250,
          createdBy: "seed",
          createdAt: now
        }
      ],
      registrations: []
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2));
  }
}

function loadDb() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveDb(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function base64UrlEncode(input) {
  return Buffer.from(input).toString("base64url");
}

function base64UrlDecode(input) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function signToken(payload) {
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyToken(token) {
  const [body, signature] = token.split(".");
  if (!body || !signature) {
    return null;
  }

  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(body));
    if (payload.exp && Date.now() > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  if (!header) {
    return {};
  }

  return header.split(";").reduce((cookies, chunk) => {
    const [key, ...rest] = chunk.trim().split("=");
    cookies[key] = decodeURIComponent(rest.join("="));
    return cookies;
  }, {});
}

function setAuthCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`
  );
}

function clearAuthCookie(res) {
  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt
  };
}

function getCurrentUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[AUTH_COOKIE];
  if (!token) {
    return null;
  }

  const payload = verifyToken(token);
  if (!payload) {
    return null;
  }

  const db = loadDb();
  return db.users.find((user) => user.id === payload.userId) || null;
}

function requireAuth(req, res, next) {
  const user = getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: "Authentication required" });
  }

  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }

  next();
}

function eventRegistrationCount(db, eventId) {
  return db.registrations.filter((registration) => registration.eventId === eventId).length;
}

function eventView(event, db, currentUser) {
  const registrations = db.registrations.filter((registration) => registration.eventId === event.id);
  const userRegistration = currentUser
    ? registrations.find((registration) => registration.userId === currentUser.id)
    : null;

  return {
    ...event,
    registrationCount: registrations.length,
    seatsLeft: Math.max(event.capacity - registrations.length, 0),
    isRegistered: Boolean(userRegistration),
    attendanceMarked: userRegistration?.status === "attended"
  };
}

async function registrationView(registration, db) {
  const event = db.events.find((item) => item.id === registration.eventId);
  return {
    ...registration,
    event,
    qrCodeDataUrl: await QRCode.toDataURL(registration.qrToken, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 280
    })
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/auth/session", (req, res) => {
  const user = getCurrentUser(req);
  res.json({ user: user ? sanitizeUser(user) : null });
});

app.post("/api/auth/register", (req, res) => {
  const { name, email, password } = req.body || {};

  if (!name || !email || !password) {
    return res.status(400).json({ error: "Name, email, and password are required" });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const db = loadDb();
  if (db.users.some((user) => user.email === normalizedEmail)) {
    return res.status(409).json({ error: "An account with this email already exists" });
  }

  const user = {
    id: crypto.randomUUID(),
    name: String(name).trim(),
    email: normalizedEmail,
    passwordHash: hashPassword(String(password)),
    role: "student",
    createdAt: new Date().toISOString()
  };

  db.users.push(user);
  saveDb(db);

  const token = signToken({
    userId: user.id,
    exp: Date.now() + 1000 * 60 * 60 * 24 * 7
  });
  setAuthCookie(res, token);
  res.status(201).json({ user: sanitizeUser(user) });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const db = loadDb();
  const user = db.users.find((item) => item.email === normalizedEmail);

  if (!user || !verifyPassword(String(password || ""), user.passwordHash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = signToken({
    userId: user.id,
    exp: Date.now() + 1000 * 60 * 60 * 24 * 7
  });
  setAuthCookie(res, token);
  res.json({ user: sanitizeUser(user) });
});

app.post("/api/auth/logout", (_req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

app.get("/api/events", requireAuth, (req, res) => {
  const db = loadDb();
  const events = db.events
    .slice()
    .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`))
    .map((event) => eventView(event, db, req.user));

  res.json({ events });
});

app.post("/api/events", requireAuth, requireAdmin, (req, res) => {
  const { title, description, location, date, time, capacity } = req.body || {};

  if (!title || !description || !location || !date || !time || !capacity) {
    return res.status(400).json({ error: "All event fields are required" });
  }

  const event = {
    id: crypto.randomUUID(),
    title: String(title).trim(),
    description: String(description).trim(),
    location: String(location).trim(),
    date: String(date),
    time: String(time),
    capacity: Number(capacity),
    createdBy: req.user.id,
    createdAt: new Date().toISOString()
  };

  const db = loadDb();
  db.events.push(event);
  saveDb(db);

  res.status(201).json({ event: eventView(event, db, req.user) });
});

app.put("/api/events/:eventId", requireAuth, requireAdmin, (req, res) => {
  const db = loadDb();
  const event = db.events.find((item) => item.id === req.params.eventId);
  if (!event) {
    return res.status(404).json({ error: "Event not found" });
  }

  const { title, description, location, date, time, capacity } = req.body || {};
  event.title = String(title || event.title).trim();
  event.description = String(description || event.description).trim();
  event.location = String(location || event.location).trim();
  event.date = String(date || event.date);
  event.time = String(time || event.time);
  event.capacity = Number(capacity || event.capacity);

  saveDb(db);
  res.json({ event: eventView(event, db, req.user) });
});

app.post("/api/events/:eventId/register", requireAuth, (req, res) => {
  if (req.user.role !== "student") {
    return res.status(403).json({ error: "Only students can register for events" });
  }

  const db = loadDb();
  const event = db.events.find((item) => item.id === req.params.eventId);
  if (!event) {
    return res.status(404).json({ error: "Event not found" });
  }

  if (eventRegistrationCount(db, event.id) >= event.capacity) {
    return res.status(409).json({ error: "This event is already full" });
  }

  const existing = db.registrations.find(
    (registration) => registration.eventId === event.id && registration.userId === req.user.id
  );

  if (existing) {
    return res.status(409).json({ error: "You are already registered for this event" });
  }

  const registration = {
    id: crypto.randomUUID(),
    eventId: event.id,
    userId: req.user.id,
    status: "registered",
    qrToken: crypto.randomUUID(),
    registeredAt: new Date().toISOString(),
    attendedAt: null
  };

  db.registrations.push(registration);
  saveDb(db);

  registrationView(registration, db)
    .then((view) => res.status(201).json({ registration: view }))
    .catch(() => res.status(500).json({ error: "Unable to generate QR code" }));
});

app.get("/api/my/registrations", requireAuth, async (req, res) => {
  const db = loadDb();
  const myRegistrations = db.registrations.filter((registration) => registration.userId === req.user.id);
  const registrations = await Promise.all(
    myRegistrations
      .slice()
      .sort((a, b) => b.registeredAt.localeCompare(a.registeredAt))
      .map((registration) => registrationView(registration, db))
  );

  res.json({ registrations });
});

app.get("/api/admin/overview", requireAuth, requireAdmin, (req, res) => {
  const db = loadDb();
  const attendanceCount = db.registrations.filter((registration) => registration.status === "attended").length;
  const recentRegistrations = db.registrations
    .slice()
    .sort((a, b) => b.registeredAt.localeCompare(a.registeredAt))
    .slice(0, 8)
    .map((registration) => {
      const event = db.events.find((item) => item.id === registration.eventId);
      const student = db.users.find((item) => item.id === registration.userId);
      return {
        id: registration.id,
        status: registration.status,
        registeredAt: registration.registeredAt,
        attendedAt: registration.attendedAt,
        eventTitle: event?.title || "Unknown Event",
        studentName: student?.name || "Unknown Student"
      };
    });

  res.json({
    stats: {
      totalEvents: db.events.length,
      totalStudents: db.users.filter((user) => user.role === "student").length,
      totalRegistrations: db.registrations.length,
      attendanceCount
    },
    recentRegistrations
  });
});

app.post("/api/attendance/scan", requireAuth, requireAdmin, (req, res) => {
  const { qrToken } = req.body || {};
  if (!qrToken) {
    return res.status(400).json({ error: "QR token is required" });
  }

  const db = loadDb();
  const registration = db.registrations.find((item) => item.qrToken === String(qrToken).trim());
  if (!registration) {
    return res.status(404).json({ error: "Registration not found for this QR code" });
  }

  const event = db.events.find((item) => item.id === registration.eventId);
  const student = db.users.find((item) => item.id === registration.userId);

  if (registration.status === "attended") {
    return res.json({
      success: true,
      alreadyMarked: true,
      registration: {
        studentName: student?.name || "Unknown Student",
        eventTitle: event?.title || "Unknown Event",
        attendedAt: registration.attendedAt
      }
    });
  }

  registration.status = "attended";
  registration.attendedAt = new Date().toISOString();
  saveDb(db);

  res.json({
    success: true,
    alreadyMarked: false,
    registration: {
      studentName: student?.name || "Unknown Student",
      eventTitle: event?.title || "Unknown Event",
      attendedAt: registration.attendedAt
    }
  });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

ensureDataFile();

app.listen(PORT, () => {
  console.log(`College event manager running at http://localhost:${PORT}`);
});
