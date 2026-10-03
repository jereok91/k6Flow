"use client";

// K6F4-03: admin user management. Thin state shell (K6F3-04 precedent): the
// repo has no testing library, so NO component test is written — every
// security-relevant decision (gate, validation, lockout guards, SafeUser
// mapping) lives in the API routes and their unit-tested logic.ts. This file
// only holds React state, fetch calls and rendering. No styling framework —
// inline styles matching app/page.tsx and app/runs/[runId]/page.tsx.
import { useCallback, useEffect, useState } from "react";

type SafeUser = {
  id: string;
  username: string;
  role: "admin" | "user";
  createdAt: string;
};

type Phase = "loading" | "anon" | "forbidden" | "ready";

// Extract the `{ error }` message the API guarantees (jsonError), falling
// back to a status-based generic so non-JSON failures still render.
async function readError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const message = (body as { error: unknown }).error;
      if (typeof message === "string") return message;
    }
  } catch {
    // fall through to the generic message
  }
  return `Request failed (${response.status})`;
}

export default function AdminUsersPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [currentUser, setCurrentUser] = useState<SafeUser | null>(null);
  const [users, setUsers] = useState<SafeUser[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Create form state.
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "user">("user");

  const refresh = useCallback(async () => {
    const response = await fetch("/api/users", { cache: "no-store" });
    if (response.status === 401 || response.status === 403) {
      setPhase("forbidden");
      return;
    }
    if (!response.ok) {
      setError(await readError(response));
      return;
    }
    const body: unknown = await response.json();
    const list =
      typeof body === "object" && body !== null && "users" in body
        ? (body as { users: SafeUser[] }).users
        : [];
    setUsers(Array.isArray(list) ? list : []);
  }, []);

  // Mount: probe the session, then the admin list. 401 from /api/auth/me →
  // "log in first"; 401/403 from GET /api/users → forbidden (the server is
  // the authority on the admin gate — the page never decides by itself).
  useEffect(() => {
    (async () => {
      const me = await fetch("/api/auth/me", { cache: "no-store" });
      if (me.status === 401) {
        setPhase("anon");
        return;
      }
      if (!me.ok) {
        setError(await readError(me));
        setPhase("anon");
        return;
      }
      const user = (await me.json()) as SafeUser;
      setCurrentUser(user);
      await refresh();
      setPhase((prev) => (prev === "loading" ? "ready" : prev));
    })();
  }, [refresh]);

  async function createUser(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const response = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole }),
    });
    if (!response.ok) {
      setError(await readError(response));
      return;
    }
    setNewUsername("");
    setNewPassword("");
    setNewRole("user");
    await refresh();
  }

  async function deleteUser(id: string) {
    setError(null);
    const response = await fetch(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) {
      setError(await readError(response));
      return;
    }
    await refresh();
  }

  async function changeRole(id: string, role: "admin" | "user") {
    setError(null);
    const response = await fetch(`/api/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (!response.ok) {
      setError(await readError(response));
      return;
    }
    await refresh();
  }

  if (phase === "loading") {
    return <main style={mainStyle}><h1>Users</h1><p>Loading…</p></main>;
  }

  if (phase === "anon") {
    return (
      <main style={mainStyle}>
        <h1>Users</h1>
        <p>You need to log in first to manage users.</p>
        {error !== null && <p style={errorStyle}>{error}</p>}
      </main>
    );
  }

  if (phase === "forbidden") {
    return (
      <main style={mainStyle}>
        <h1>Users</h1>
        <p>Forbidden — your account does not have the admin role.</p>
      </main>
    );
  }

  return (
    <main style={mainStyle}>
      <h1>Users</h1>
      <p>Signed in as {currentUser?.username ?? "unknown"}.</p>
      {error !== null && <p style={errorStyle}>{error}</p>}

      <section style={{ marginTop: "2rem" }}>
        <h2>Create user</h2>
        <form onSubmit={createUser} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <input
            value={newUsername}
            onChange={(event) => setNewUsername(event.target.value)}
            placeholder="username"
            aria-label="username"
            required
            style={{ flex: 1, minWidth: "10rem", padding: "0.5rem" }}
          />
          <input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            placeholder="password (min 12 chars)"
            aria-label="password"
            required
            style={{ flex: 1, minWidth: "12rem", padding: "0.5rem" }}
          />
          <select
            value={newRole}
            onChange={(event) => setNewRole(event.target.value as "admin" | "user")}
            aria-label="role"
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
          <button type="submit">Create</button>
        </form>
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h2>All users</h2>
        <table style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["username", "role", "created", "actions"].map((head) => (
                <th key={head} style={thStyle}>{head}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td style={cellStyle}>
                  {user.username}
                  {user.id === currentUser?.id ? " (you)" : ""}
                </td>
                <td style={cellStyle}>
                  <select
                    value={user.role}
                    onChange={(event) =>
                      changeRole(user.id, event.target.value as "admin" | "user")
                    }
                    aria-label={`role of ${user.username}`}
                  >
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td style={cellStyle}>{new Date(user.createdAt).toLocaleString()}</td>
                <td style={cellStyle}>
                  <button type="button" onClick={() => deleteUser(user.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

const mainStyle = { maxWidth: "48rem", margin: "0 auto", padding: "4rem 2rem" } as const;
const errorStyle = { color: "#b00020" } as const;
const thStyle = { border: "1px solid #333", padding: "4px 8px", textAlign: "left" } as const;
const cellStyle = { border: "1px solid #333", padding: "4px 8px" } as const;
