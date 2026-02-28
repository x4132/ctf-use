import type { RunTaskOptions } from "./pool.js";

export interface PresetTask {
  prompt: string;
  options: RunTaskOptions;
}

export function recon(targetUrl: string): PresetTask {
  return {
    prompt: `Navigate to ${targetUrl}. Perform web reconnaissance and report:
1. All forms: action URL, method, input fields (name, type, id).
2. All cookies: name, value, domain, path, httpOnly, secure flags.
3. Response headers.
4. Web framework / technology stack (from headers, meta tags, source).
5. All internal links found on the page.
6. All JavaScript files loaded and their source URLs.
7. Any hidden form fields or interesting HTML comments.
Return all findings as structured JSON.`,
    options: { model: "bu-mini" },
  };
}

export function xssProbe(targetUrl: string, paramName: string): PresetTask {
  return {
    prompt: `Navigate to ${targetUrl}. Find the input or URL parameter named "${paramName}".
Test these XSS payloads in sequence:
1. <script>alert('XSS')</script>
2. <img src=x onerror=alert(1)>
3. " onmouseover="alert(1)
4. '><svg/onload=alert(1)>
5. javascript:alert(1)

For each payload:
- Submit via the form or URL parameter.
- Check the page source to see if the payload appears unescaped in the HTML.
- Report whether it was reflected, encoded, or blocked.

Return structured findings: { payload, reflected: boolean, context: string, encoded: boolean, blocked: boolean, notes: string } for each.
Also report any WAF/filter observations.`,
    options: { model: "bu-max" },
  };
}

export function sqliProbe(targetUrl: string, paramName: string): PresetTask {
  return {
    prompt: `Navigate to ${targetUrl}. Find the input or URL parameter named "${paramName}".
Test these SQL injection payloads in sequence:
1. ' (single quote) — check for SQL error messages
2. ' OR '1'='1 — check for auth bypass or data change
3. ' UNION SELECT NULL-- — check for UNION injection
4. ' AND 1=1-- vs ' AND 1=2-- — check for boolean-based blind SQLi
5. ' AND SLEEP(3)-- — check for time-based blind SQLi (note response time)
6. 1; DROP TABLE test-- — check for stacked queries

For each payload, report:
- The payload used
- HTTP response status
- Any error messages visible on the page
- Whether behavior changed compared to normal input
- Response time in seconds
- The database error type if identifiable (MySQL, PostgreSQL, SQLite, MSSQL)

Return all findings as structured JSON.`,
    options: { model: "bu-max" },
  };
}

export function sourceAnalysis(targetUrl: string): PresetTask {
  return {
    prompt: `Navigate to ${targetUrl}. Analyze the complete page source:
1. HTML comments — look for hints, flags, credentials, TODOs.
2. Hidden form fields and their values.
3. Inline JavaScript — hardcoded secrets, API keys, endpoints, debug code.
4. Meta tags — look for generator, author, or interesting metadata.
5. Check for development/debug artifacts (console.log, stack traces, error messages).
6. Check robots.txt and sitemap.xml if they exist.
7. Look for references to admin, backup, config, or debug paths.
8. Check for any strings matching common flag formats (flag{...}, CTF{...}, etc.).

Return all findings as structured JSON.`,
    options: { model: "bu-mini" },
  };
}

export function formSubmit(
  targetUrl: string,
  formSelector: string,
  fields: Record<string, string>,
): PresetTask {
  return {
    prompt: `Navigate to ${targetUrl}. Find the form matching "${formSelector}".
Fill in the following fields: ${JSON.stringify(fields)}.
Submit the form. Report:
1. The resulting page URL after submission.
2. The full response body text (or key portions if very long).
3. Any new cookies set after submission.
4. Any redirect chain that occurred (intermediate URLs and status codes).
5. Any error messages or success messages displayed.
6. Any changes in page content compared to before submission.

Return all findings as structured JSON.`,
    options: { model: "bu-mini" },
  };
}

export function cookieAnalysis(targetUrl: string): PresetTask {
  return {
    prompt: `Navigate to ${targetUrl}. Perform cookie and session analysis:
1. List all cookies with full details: name, value, domain, path, expires, httpOnly, secure, sameSite.
2. For any base64-encoded cookie values, decode and show the plaintext.
3. If any cookies look like JWT tokens, decode the header and payload (split by dots, base64-decode each part).
4. Check if session cookies change on page refresh (session fixation test).
5. Test if cookies are accessible via document.cookie (JavaScript access).
6. Look for any cookie values that appear to encode user roles, IDs, or permissions.

Return all findings as structured JSON.`,
    options: { model: "bu-max" },
  };
}

export function pathDiscovery(targetUrl: string): PresetTask {
  return {
    prompt: `Starting from ${targetUrl}, check each of these paths and report which return non-404 responses:
/robots.txt, /sitemap.xml, /.git/HEAD, /.git/config, /.env, /.env.bak,
/admin, /login, /register, /api, /api/v1, /debug, /trace,
/backup, /config, /phpinfo.php, /.htaccess, /wp-admin, /wp-login.php,
/swagger, /swagger-ui, /graphql, /graphiql,
/flag, /flag.txt, /secret, /secret.txt,
/.DS_Store, /server-status, /server-info,
/console, /actuator, /actuator/health, /actuator/env

For each path that returns a non-404 response, report:
- The full URL
- HTTP status code
- Brief summary of the content (first 200 chars)
- Whether it reveals sensitive information

Return all findings as structured JSON.`,
    options: { model: "bu-mini" },
  };
}
