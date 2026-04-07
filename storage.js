const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "db.json");
const DATABASE_URL = process.env.DATABASE_URL;
const IS_VERCEL = process.env.VERCEL === "1" || process.env.VERCEL === "true";
const USE_POSTGRES = Boolean(DATABASE_URL);

let pool = null;
let initPromise = null;

function createSeed() {
  const now = new Date().toISOString();
  return {
    users: [
      {
        id: crypto.randomUUID(),
        name: "Campus Admin",
        email: "admin@college.local",
        passwordHash: null,
        role: "admin",
        createdAt: now
      },
      {
        id: crypto.randomUUID(),
        name: "Demo Student",
        email: "student@college.local",
        passwordHash: null,
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
}

function ensureLocalFile(hashPassword) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    const seed = createSeed();
    seed.users[0].passwordHash = hashPassword("admin123");
    seed.users[1].passwordHash = hashPassword("student123");
    fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2));
  }
}

function loadLocalDb(hashPassword) {
  ensureLocalFile(hashPassword);
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveLocalDb(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL && DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
    });
  }
  return pool;
}

async function ensurePostgres(hashPassword) {
  if (!USE_POSTGRES) {
    if (IS_VERCEL) {
      throw new Error("DATABASE_URL is required on Vercel for persistent storage.");
    }
    return;
  }

  if (!initPromise) {
    initPromise = (async () => {
      const client = await getPool().connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('admin', 'student')),
            created_at TIMESTAMPTZ NOT NULL
          );
        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            location TEXT NOT NULL,
            event_date DATE NOT NULL,
            event_time TIME NOT NULL,
            capacity INTEGER NOT NULL CHECK (capacity > 0),
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL
          );
        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS registrations (
            id TEXT PRIMARY KEY,
            event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            status TEXT NOT NULL CHECK (status IN ('registered', 'attended')),
            qr_token TEXT NOT NULL UNIQUE,
            registered_at TIMESTAMPTZ NOT NULL,
            attended_at TIMESTAMPTZ,
            UNIQUE (event_id, user_id)
          );
        `);

        const countResult = await client.query("SELECT COUNT(*)::int AS count FROM users");
        if (Number(countResult.rows[0].count) === 0) {
          const seed = createSeed();
          seed.users[0].passwordHash = hashPassword("admin123");
          seed.users[1].passwordHash = hashPassword("student123");

          for (const user of seed.users) {
            await client.query(
              "INSERT INTO users (id, name, email, password_hash, role, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
              [user.id, user.name, user.email, user.passwordHash, user.role, user.createdAt]
            );
          }

          for (const event of seed.events) {
            await client.query(
              `
                INSERT INTO events (id, title, description, location, event_date, event_time, capacity, created_by, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
              `,
              [
                event.id,
                event.title,
                event.description,
                event.location,
                event.date,
                event.time,
                event.capacity,
                event.createdBy,
                event.createdAt
              ]
            );
          }
        }
      } finally {
        client.release();
      }
    })();
  }

  await initPromise;
}

function mapUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    createdAt: new Date(row.created_at).toISOString()
  };
}

function mapEvent(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    location: row.location,
    date: row.event_date instanceof Date ? row.event_date.toISOString().slice(0, 10) : String(row.event_date),
    time: String(row.event_time).slice(0, 5),
    capacity: Number(row.capacity),
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString()
  };
}

function mapRegistration(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    userId: row.user_id,
    status: row.status,
    qrToken: row.qr_token,
    registeredAt: new Date(row.registered_at).toISOString(),
    attendedAt: row.attended_at ? new Date(row.attended_at).toISOString() : null
  };
}

async function query(text, params = []) {
  const result = await getPool().query(text, params);
  return result.rows;
}

function createStorage(hashPassword) {
  return {
    async ready() {
      await ensurePostgres(hashPassword);
    },

    async getUserByEmail(email) {
      if (USE_POSTGRES) {
        await ensurePostgres(hashPassword);
        const rows = await query("SELECT * FROM users WHERE email = $1 LIMIT 1", [email]);
        return rows[0] ? mapUser(rows[0]) : null;
      }

      const db = loadLocalDb(hashPassword);
      return db.users.find((user) => user.email === email) || null;
    },

    async getUserById(id) {
      if (USE_POSTGRES) {
        await ensurePostgres(hashPassword);
        const rows = await query("SELECT * FROM users WHERE id = $1 LIMIT 1", [id]);
        return rows[0] ? mapUser(rows[0]) : null;
      }

      const db = loadLocalDb(hashPassword);
      return db.users.find((user) => user.id === id) || null;
    },

    async countStudents() {
      if (USE_POSTGRES) {
        await ensurePostgres(hashPassword);
        const rows = await query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'student'");
        return Number(rows[0].count);
      }

      const db = loadLocalDb(hashPassword);
      return db.users.filter((user) => user.role === "student").length;
    },

    async createUser(user) {
      if (USE_POSTGRES) {
        await ensurePostgres(hashPassword);
        const rows = await query(
          `
            INSERT INTO users (id, name, email, password_hash, role, created_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
          `,
          [user.id, user.name, user.email, user.passwordHash, user.role, user.createdAt]
        );
        return mapUser(rows[0]);
      }

      const db = loadLocalDb(hashPassword);
      db.users.push(user);
      saveLocalDb(db);
      return user;
    },

    async listEvents() {
      if (USE_POSTGRES) {
        await ensurePostgres(hashPassword);
        const rows = await query("SELECT * FROM events ORDER BY event_date ASC, event_time ASC");
        return rows.map(mapEvent);
      }

      const db = loadLocalDb(hashPassword);
      return db.events.slice().sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
    },

    async getEventById(id) {
      if (USE_POSTGRES) {
        await ensurePostgres(hashPassword);
        const rows = await query("SELECT * FROM events WHERE id = $1 LIMIT 1", [id]);
        return rows[0] ? mapEvent(rows[0]) : null;
      }

      const db = loadLocalDb(hashPassword);
      return db.events.find((event) => event.id === id) || null;
    },

    async createEvent(event) {
      if (USE_POSTGRES) {
        await ensurePostgres(hashPassword);
        const rows = await query(
          `
            INSERT INTO events (id, title, description, location, event_date, event_time, capacity, created_by, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
          `,
          [
            event.id,
            event.title,
            event.description,
            event.location,
            event.date,
            event.time,
            event.capacity,
            event.createdBy,
            event.createdAt
          ]
        );
        return mapEvent(rows[0]);
      }

      const db = loadLocalDb(hashPassword);
      db.events.push(event);
      saveLocalDb(db);
      return event;
    },

    async updateEvent(eventId, changes) {
      if (USE_POSTGRES) {
        await ensurePostgres(hashPassword);
        const current = await this.getEventById(eventId);
        if (!current) {
          return null;
        }

        const rows = await query(
          `
            UPDATE events
            SET title = $2,
                description = $3,
                location = $4,
                event_date = $5,
                event_time = $6,
                capacity = $7
            WHERE id = $1
            RETURNING *
          `,
          [
            eventId,
            changes.title ?? current.title,
            changes.description ?? current.description,
            changes.location ?? current.location,
            changes.date ?? current.date,
            changes.time ?? current.time,
            changes.capacity ?? current.capacity
          ]
        );
        return rows[0] ? mapEvent(rows[0]) : null;
      }

      const db = loadLocalDb(hashPassword);
      const event = db.events.find((item) => item.id === eventId);
      if (!event) {
        return null;
      }
      event.title = changes.title ?? event.title;
      event.description = changes.description ?? event.description;
      event.location = changes.location ?? event.location;
      event.date = changes.date ?? event.date;
      event.time = changes.time ?? event.time;
      event.capacity = changes.capacity ?? event.capacity;
      saveLocalDb(db);
      return event;
    },

    async listRegistrations() {
      if (USE_POSTGRES) {
        await ensurePostgres(hashPassword);
        const rows = await query("SELECT * FROM registrations ORDER BY registered_at DESC");
        return rows.map(mapRegistration);
      }

      const db = loadLocalDb(hashPassword);
      return db.registrations.slice().sort((a, b) => b.registeredAt.localeCompare(a.registeredAt));
    },

    async countAttendances() {
      if (USE_POSTGRES) {
        await ensurePostgres(hashPassword);
        const rows = await query("SELECT COUNT(*)::int AS count FROM registrations WHERE status = 'attended'");
        return Number(rows[0].count);
      }

      const db = loadLocalDb(hashPassword);
      return db.registrations.filter((registration) => registration.status === "attended").length;
    },

    async getRegistrationsForEvent(eventId) {
      if (USE_POSTGRES) {
        await ensurePostgres(hashPassword);
        const rows = await query("SELECT * FROM registrations WHERE event_id = $1", [eventId]);
        return rows.map(mapRegistration);
      }

      const db = loadLocalDb(hashPassword);
      return db.registrations.filter((registration) => registration.eventId === eventId);
    },

    async getRegistrationsForUser(userId) {
      if (USE_POSTGRES) {
        await ensurePostgres(hashPassword);
        const rows = await query("SELECT * FROM registrations WHERE user_id = $1 ORDER BY registered_at DESC", [userId]);
        return rows.map(mapRegistration);
      }

      const db = loadLocalDb(hashPassword);
      return db.registrations
        .filter((registration) => registration.userId === userId)
        .sort((a, b) => b.registeredAt.localeCompare(a.registeredAt));
    },

    async getRegistrationForEventAndUser(eventId, userId) {
      if (USE_POSTGRES) {
        await ensurePostgres(hashPassword);
        const rows = await query(
          "SELECT * FROM registrations WHERE event_id = $1 AND user_id = $2 LIMIT 1",
          [eventId, userId]
        );
        return rows[0] ? mapRegistration(rows[0]) : null;
      }

      const db = loadLocalDb(hashPassword);
      return db.registrations.find((registration) => registration.eventId === eventId && registration.userId === userId) || null;
    },

    async createRegistration(registration) {
      if (USE_POSTGRES) {
        await ensurePostgres(hashPassword);
        const rows = await query(
          `
            INSERT INTO registrations (id, event_id, user_id, status, qr_token, registered_at, attended_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
          `,
          [
            registration.id,
            registration.eventId,
            registration.userId,
            registration.status,
            registration.qrToken,
            registration.registeredAt,
            registration.attendedAt
          ]
        );
        return mapRegistration(rows[0]);
      }

      const db = loadLocalDb(hashPassword);
      db.registrations.push(registration);
      saveLocalDb(db);
      return registration;
    },

    async getRegistrationByQrToken(qrToken) {
      if (USE_POSTGRES) {
        await ensurePostgres(hashPassword);
        const rows = await query("SELECT * FROM registrations WHERE qr_token = $1 LIMIT 1", [qrToken]);
        return rows[0] ? mapRegistration(rows[0]) : null;
      }

      const db = loadLocalDb(hashPassword);
      return db.registrations.find((registration) => registration.qrToken === qrToken) || null;
    },

    async markAttendance(registrationId, attendedAt) {
      if (USE_POSTGRES) {
        await ensurePostgres(hashPassword);
        const rows = await query(
          `
            UPDATE registrations
            SET status = 'attended',
                attended_at = $2
            WHERE id = $1
            RETURNING *
          `,
          [registrationId, attendedAt]
        );
        return rows[0] ? mapRegistration(rows[0]) : null;
      }

      const db = loadLocalDb(hashPassword);
      const registration = db.registrations.find((item) => item.id === registrationId);
      if (!registration) {
        return null;
      }
      registration.status = "attended";
      registration.attendedAt = attendedAt;
      saveLocalDb(db);
      return registration;
    }
  };
}

module.exports = {
  createStorage,
  USE_POSTGRES,
  IS_VERCEL
};
