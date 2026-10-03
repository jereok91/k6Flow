import type { User } from "../db/schema";

// K6F4-02a: SafeUser is the ONLY user shape that leaves the auth layer. The
// passwordHash field is unrepresentable at the type level, so route handlers
// cannot leak credentials by accident.
export type SafeUser = {
  id: string;
  username: string;
  role: "admin" | "user";
  createdAt: Date;
};

// Pure mapping: copies the public fields and drops passwordHash entirely.
// Non-'admin' roles normalize to 'user' (the schema CHECK already restricts
// the column to 'admin'|'user').
export function toSafeUser(user: User): SafeUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role === "admin" ? "admin" : "user",
    createdAt: user.createdAt,
  };
}
