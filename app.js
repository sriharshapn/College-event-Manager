const express = require("express");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");
const { createStorage, USE_POSTGRES, IS_VERCEL } = require("./storage");

const app = express();
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

const storage = createStorage(hashPassword);

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

async function getCurrentUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[AUTH_COOKIE];
  if (!token) {
    return null;
  }

  const payload = verifyToken(token);
  if (!payload) {
    return null;
  }

  return storage.getUserById(payload.userId);
}

async function requireAuth(req, res, next) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }

  next();
}

function eventRegistrationCount(registrations, eventId) {
  return registrations.filter((registration) => registration.eventId === eventId).length;
}

function eventView(event, registrations, currentUser) {
  const eventRegistrations = registrations.filter((registration) => registration.eventId === event.id);
  const userRegistration = currentUser
    ? eventRegistrations.find((registration) => registration.userId === currentUser.id)
    : null;

  return {
    ...event,
    registrationCount: eventRegistrations.length,
    seatsLeft: Math.max(event.capacity - eventRegistrations.length, 0),
    isRegistered: Boolean(userRegistration),
    attendanceMarked: userRegistration?.status === "attended"
  };
}

async function registrationView(registration, events) {
  const event = events.find((item) => item.id === registration.eventId);
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
  res.json({
    ok: true,
    runtime: IS_VERCEL ? "vercel" : "node",
    storage: USE_POSTGRES ? "postgres" : "local-file"
  });
});

app.get("/api/auth/session", async (req, res, next) => {
  try {
    const user = await getCurrentUser(req);
    res.json({ user: user ? sanitizeUser(user) : null });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email, and password are required" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const existingUser = await storage.getUserByEmail(normalizedEmail);
    if (existingUser) {
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

    await storage.createUser(user);

    const token = signToken({
      userId: user.id,
      exp: Date.now() + 1000 * 60 * 60 * 24 * 7
    });
    setAuthCookie(res, token);
    res.status(201).json({ user: sanitizeUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const user = await storage.getUserByEmail(normalizedEmail);

    if (!user || !verifyPassword(String(password || ""), user.passwordHash)) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = signToken({
      userId: user.id,
      exp: Date.now() + 1000 * 60 * 60 * 24 * 7
    });
    setAuthCookie(res, token);
    res.json({ user: sanitizeUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", (_req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

app.get("/api/events", requireAuth, async (req, res, next) => {
  try {
    const [events, registrations] = await Promise.all([storage.listEvents(), storage.listRegistrations()]);
    res.json({
      events: events.map((event) => eventView(event, registrations, req.user))
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/events", requireAuth, requireAdmin, async (req, res, next) => {
  try {
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

    const createdEvent = await storage.createEvent(event);
    res.status(201).json({ event: eventView(createdEvent, [], req.user) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/events/:eventId", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const existingEvent = await storage.getEventById(req.params.eventId);
    if (!existingEvent) {
      return res.status(404).json({ error: "Event not found" });
    }

    const { title, description, location, date, time, capacity } = req.body || {};
    const updatedEvent = await storage.updateEvent(req.params.eventId, {
      title: title ? String(title).trim() : undefined,
      description: description ? String(description).trim() : undefined,
      location: location ? String(location).trim() : undefined,
      date: date ? String(date) : undefined,
      time: time ? String(time) : undefined,
      capacity: capacity ? Number(capacity) : undefined
    });
    const registrations = await storage.getRegistrationsForEvent(req.params.eventId);

    res.json({ event: eventView(updatedEvent, registrations, req.user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/events/:eventId/register", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "student") {
      return res.status(403).json({ error: "Only students can register for events" });
    }

    const event = await storage.getEventById(req.params.eventId);
    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const registrations = await storage.getRegistrationsForEvent(event.id);
    if (eventRegistrationCount(registrations, event.id) >= event.capacity) {
      return res.status(409).json({ error: "This event is already full" });
    }

    const existing = await storage.getRegistrationForEventAndUser(event.id, req.user.id);
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

    const createdRegistration = await storage.createRegistration(registration);
    const view = await registrationView(createdRegistration, [event]);
    res.status(201).json({ registration: view });
  } catch (error) {
    console.error("Registration flow failed", error);
    next(error);
  }
});

app.get("/api/my/registrations", requireAuth, async (req, res, next) => {
  try {
    const [events, myRegistrations] = await Promise.all([
      storage.listEvents(),
      storage.getRegistrationsForUser(req.user.id)
    ]);
    const registrations = await Promise.all(
      myRegistrations.map((registration) => registrationView(registration, events))
    );

    res.json({ registrations });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/overview", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const [events, registrations, attendanceCount, studentCount] = await Promise.all([
      storage.listEvents(),
      storage.listRegistrations(),
      storage.countAttendances(),
      storage.countStudents()
    ]);

    const recentRegistrations = await Promise.all(
      registrations.slice(0, 8).map(async (registration) => {
        const [event, student] = await Promise.all([
          storage.getEventById(registration.eventId),
          storage.getUserById(registration.userId)
        ]);
        return {
          id: registration.id,
          status: registration.status,
          registeredAt: registration.registeredAt,
          attendedAt: registration.attendedAt,
          eventTitle: event?.title || "Unknown Event",
          studentName: student?.name || "Unknown Student"
        };
      })
    );

    res.json({
      stats: {
        totalEvents: events.length,
        totalStudents: studentCount,
        totalRegistrations: registrations.length,
        attendanceCount
      },
      recentRegistrations
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/attendance/scan", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { qrToken } = req.body || {};
    if (!qrToken) {
      return res.status(400).json({ error: "QR token is required" });
    }

    const registration = await storage.getRegistrationByQrToken(String(qrToken).trim());
    if (!registration) {
      return res.status(404).json({ error: "Registration not found for this QR code" });
    }

    const [event, student] = await Promise.all([
      storage.getEventById(registration.eventId),
      storage.getUserById(registration.userId)
    ]);

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

    const updatedRegistration = await storage.markAttendance(registration.id, new Date().toISOString());
    res.json({
      success: true,
      alreadyMarked: false,
      registration: {
        studentName: student?.name || "Unknown Student",
        eventTitle: event?.title || "Unknown Event",
        attendedAt: updatedRegistration.attendedAt
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error("Unhandled request error", error);
  res.status(500).json({
    error: IS_VERCEL && !USE_POSTGRES
      ? "Server storage is not configured. Set DATABASE_URL on Vercel."
      : "Internal server error"
  });
});

storage.ready().catch((error) => {
  console.error("Storage initialization failed", error);
});

module.exports = app;
