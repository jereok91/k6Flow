import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Global auth middleware: redirects unauthenticated users to /login.
 * 
 * Public routes (no auth required):
 * - /login (the login page itself)
 * - /api/auth/* (login, logout, me endpoints)
 * - /api/healthz (health check for orchestration)
 * - /_next/* (static assets)
 * - /favicon.ico, /robots.txt, etc.
 */

const PUBLIC_PATHS = [
  "/login",
  "/api/auth",
  "/api/healthz",
];

const STATIC_EXTENSIONS = [
  ".ico",
  ".png",
  ".jpg",
  ".jpeg",
  ".svg",
  ".css",
  ".js",
  ".woff",
  ".woff2",
];

function isPublicPath(pathname: string): boolean {
  // Static files
  if (pathname.startsWith("/_next")) return true;
  if (STATIC_EXTENSIONS.some(ext => pathname.endsWith(ext))) return true;
  
  // Public routes
  for (const publicPath of PUBLIC_PATHS) {
    if (pathname === publicPath || pathname.startsWith(publicPath + "/")) {
      return true;
    }
  }
  
  return false;
}

const SESSION_COOKIE = "k6flow_session";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  
  // Allow public paths
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }
  
  // Check for session cookie
  const sessionToken = request.cookies.get(SESSION_COOKIE)?.value;
  
  if (!sessionToken) {
    // No session → redirect to login
    const loginUrl = new URL("/login", request.url);
    // Preserve the original URL for redirect after login
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }
  
  // Has session cookie → allow (actual validation happens in API routes)
  // Note: This only checks cookie presence, not validity.
  // Invalid/expired sessions will fail on API calls and the UI handles that.
  return NextResponse.next();
}

export const config = {
  // Match all paths except static files
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
