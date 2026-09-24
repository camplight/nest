/** Prefer the current product's cookie regardless of browser cookie ordering. */
export function readSessionId(cookieHeader: string): string | undefined {
  const cookies = cookieHeader.split(";").map((cookie) => cookie.trim());
  for (const name of ["nest_session", "orgops_session"]) {
    const cookie = cookies.find((value) => value.startsWith(`${name}=`));
    if (cookie) return cookie.slice(name.length + 1) || undefined;
  }
  return undefined;
}
