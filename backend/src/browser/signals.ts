export type SignalType =
  | "xss_reflected"
  | "xss_stored"
  | "sqli_error"
  | "sqli_blind"
  | "sqli_union"
  | "lfi"
  | "open_redirect"
  | "auth_bypass"
  | "sensitive_data"
  | "hidden_endpoint"
  | "interesting_cookie"
  | "source_leak"
  | "flag_found"
  | "custom";

export interface Signal {
  type: SignalType;
  confidence: "low" | "medium" | "high";
  source: { taskId: string; prompt: string };
  details: string;
  evidence: string;
  suggestedFollowUps: string[];
}

interface SignalPattern {
  type: SignalType;
  patterns: RegExp[];
  confidence: Signal["confidence"];
  followUp: (match: string) => string[];
}

const SIGNAL_PATTERNS: SignalPattern[] = [
  {
    type: "flag_found",
    patterns: [
      /(?:flag|ctf|htb|thm|picoCTF)\{[^}]+\}/i,
      /FLAG[=: ]+\S+/i,
    ],
    confidence: "high",
    followUp: () => ["Verify the flag by submitting it"],
  },
  {
    type: "sqli_error",
    patterns: [
      /SQL syntax.*?near/i,
      /mysql_fetch|mysql_num_rows|mysql_query/i,
      /ORA-\d{5}/,
      /PostgreSQL.*?ERROR/i,
      /SQLite3?::SQLException/i,
      /SQLSTATE\[/i,
      /unclosed quotation mark/i,
      /quoted string not properly terminated/i,
      /You have an error in your SQL syntax/i,
    ],
    confidence: "high",
    followUp: (_match) => [
      `Attempt UNION-based SQL injection to extract data`,
      `Try boolean-based blind SQLi to enumerate tables`,
      `Check for time-based blind SQLi with SLEEP/WAITFOR`,
    ],
  },
  {
    type: "sqli_blind",
    patterns: [
      /(?:behavior|response)\s+changed.*(?:true|false|1=1|1=2)/i,
      /boolean.*blind.*(?:sql|injection)/i,
      /time.*based.*(?:sql|injection)/i,
      /response.*time.*(?:differ|delay|sleep)/i,
    ],
    confidence: "medium",
    followUp: () => [
      `Exploit blind SQLi to extract database schema`,
      `Use time-based techniques to exfiltrate data`,
    ],
  },
  {
    type: "sqli_union",
    patterns: [
      /UNION.*SELECT.*(?:worked|success|returned)/i,
      /number of columns.*(?:match|correct)/i,
    ],
    confidence: "high",
    followUp: () => [
      `Use UNION SELECT to extract table names from information_schema`,
      `Dump user credentials via UNION injection`,
    ],
  },
  {
    type: "xss_reflected",
    patterns: [
      /(?:payload|script|tag).*(?:reflected|unescaped|rendered|executed)/i,
      /alert\s*\(\s*['"]?(?:1|XSS)['"]?\s*\).*(?:triggered|fired|executed)/i,
      /<script>.*(?:appeared|found|present).*(?:unencoded|unescaped|raw)/i,
      /reflected.*(?:without|no).*(?:encoding|escaping|sanitiz)/i,
    ],
    confidence: "high",
    followUp: (_match) => [
      `Craft a payload to steal cookies or session tokens`,
      `Test for stored XSS by submitting persistent payloads`,
      `Check if CSP headers block script execution`,
    ],
  },
  {
    type: "xss_stored",
    patterns: [
      /stored.*(?:xss|cross.site)/i,
      /payload.*(?:persisted|saved|stored).*(?:database|server)/i,
    ],
    confidence: "high",
    followUp: () => [
      `Exploit stored XSS to exfiltrate data from other users`,
      `Test if the stored payload can access admin functionality`,
    ],
  },
  {
    type: "lfi",
    patterns: [
      /root:x:0:0/,
      /\[boot loader\]/i,
      /etc\/passwd/i,
      /\.\.\/.*(?:success|accessible|readable)/i,
      /local file inclusion/i,
      /path traversal.*(?:success|works|vulnerable)/i,
    ],
    confidence: "high",
    followUp: () => [
      `Try reading /etc/shadow or application config files`,
      `Attempt to read application source code via LFI`,
      `Check for log poisoning to escalate LFI to RCE`,
    ],
  },
  {
    type: "open_redirect",
    patterns: [
      /redirect.*(?:external|arbitrary|controlled)/i,
      /open redirect.*(?:found|detected|confirmed)/i,
      /(?:url|redirect|next|return|goto).*parameter.*redirect/i,
    ],
    confidence: "medium",
    followUp: () => [
      `Chain open redirect with OAuth flows for token theft`,
      `Use redirect for phishing or SSRF`,
    ],
  },
  {
    type: "auth_bypass",
    patterns: [
      /(?:authentication|auth|login).*(?:bypass|skip|circumvent)/i,
      /(?:access|entered|reached).*(?:admin|dashboard|panel).*(?:without|no).*(?:auth|login|cred)/i,
      /(?:admin|privileged|restricted).*(?:access|area).*(?:granted|accessible)/i,
    ],
    confidence: "high",
    followUp: () => [
      `Explore admin panel for sensitive data or flag`,
      `Check for privilege escalation paths`,
      `Look for file upload or command execution features`,
    ],
  },
  {
    type: "sensitive_data",
    patterns: [
      /(?:api[_-]?key|secret[_-]?key|password|token|credential)[\s=:]+\S+/i,
      /(?:aws|azure|gcp).*(?:key|secret|token)/i,
      /Bearer\s+[A-Za-z0-9\-._~+/]+=*/,
      /(?:private|secret).*key.*(?:found|exposed|visible|leaked)/i,
    ],
    confidence: "medium",
    followUp: (_match) => [
      `Use the exposed credentials to access protected resources`,
      `Check if the leaked key grants access to other services`,
    ],
  },
  {
    type: "hidden_endpoint",
    patterns: [
      /(?:\/admin|\/debug|\/backup|\/config|\/\.git|\/\.env|\/api\/internal).*(?:accessible|found|200|exists)/i,
      /(?:robots\.txt|sitemap\.xml).*(?:disallow|hidden|secret|interesting)/i,
      /(?:status|response)\s*(?:code)?:?\s*200.*(?:admin|debug|backup|config)/i,
    ],
    confidence: "medium",
    followUp: (_match) => [
      `Navigate to the hidden endpoint and inspect its contents`,
      `Check for sensitive configuration or source code exposure`,
    ],
  },
  {
    type: "interesting_cookie",
    patterns: [
      /(?:jwt|json web token).*(?:found|decoded|header|payload)/i,
      /(?:cookie|session).*(?:not.*httponly|not.*secure|predictable|weak)/i,
      /(?:base64|decoded).*(?:cookie|token|session).*(?:contains|reveals)/i,
      /(?:admin|role|isAdmin|privilege).*(?:cookie|token|claim)/i,
    ],
    confidence: "medium",
    followUp: () => [
      `Decode and analyze the token/cookie structure`,
      `Attempt to forge or modify the token for privilege escalation`,
      `Check for JWT none algorithm or weak signing key`,
    ],
  },
  {
    type: "source_leak",
    patterns: [
      /<!--.*(?:todo|fixme|hack|password|secret|flag|admin|debug)/i,
      /(?:source\s*code|page\s*source).*(?:comment|hidden|debug|credential|hint)/i,
      /(?:\.git\/HEAD|\.env|\.DS_Store|\.htaccess).*(?:accessible|found|readable)/i,
      /(?:phpinfo|server-status|debug).*(?:page|endpoint).*(?:accessible|found)/i,
    ],
    confidence: "medium",
    followUp: () => [
      `Extract and analyze the leaked source code or configuration`,
      `Look for hardcoded credentials or internal paths in the source`,
      `Check for version control artifacts (.git) to reconstruct repo`,
    ],
  },
];

export function extractSignals(
  taskId: string,
  prompt: string,
  output: string,
): Signal[] {
  const signals: Signal[] = [];
  const seen = new Set<string>();

  for (const pattern of SIGNAL_PATTERNS) {
    for (const regex of pattern.patterns) {
      const match = regex.exec(output);
      if (match) {
        const key = `${pattern.type}:${match[0].slice(0, 100)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        signals.push({
          type: pattern.type,
          confidence: pattern.confidence,
          source: { taskId, prompt },
          details: `Matched pattern: ${regex.source}`,
          evidence: extractContext(output, match.index, 200),
          suggestedFollowUps: pattern.followUp(match[0]),
        });
        break; // one signal per pattern type per extraction
      }
    }
  }

  return signals;
}

function extractContext(text: string, index: number, radius: number): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  let context = text.slice(start, end);
  if (start > 0) context = "..." + context;
  if (end < text.length) context = context + "...";
  return context;
}
