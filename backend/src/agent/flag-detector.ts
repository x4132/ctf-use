import Dedalus from "dedalus-labs";
import { zodResponseFormat } from "dedalus-labs/helpers/zod";
import { z } from "zod";

const FlagDetectionSchema = z.object({
  found: z.boolean().describe("Whether a CTF flag was genuinely found and captured by the agent"),
  flag: z.string().nullable().describe("The exact flag string if found, null otherwise"),
  confidence: z.enum(["high", "medium", "low"]).describe("Confidence that this is a real captured flag vs a false positive"),
});

export type FlagDetectionResult = z.infer<typeof FlagDetectionSchema>;

let client: Dedalus | null = null;

function getClient(): Dedalus {
  if (!client) {
    client = new Dedalus();
  }
  return client;
}

/**
 * Use an LLM with structured output to determine if the agent actually found a CTF flag.
 * This avoids false positives from regex matching hex dumps, assembly, or partial strings.
 */
export async function detectFlag(text: string): Promise<FlagDetectionResult> {
  // Truncate to last ~8000 chars to stay within context limits while keeping relevant output
  const truncated = text.length > 8000 ? text.slice(-8000) : text;

  try {
    const completion = await getClient().chat.completions.parse({
      model: "openai/gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a CTF flag detection system. Analyze the agent's output and determine if a real CTF flag was successfully captured.

A real flag is one that the agent explicitly identified and extracted as the challenge solution. Common formats: flag{...}, CTF{...}, picoCTF{...}, HTB{...}, THM{...}, or challenge-specific formats.

FALSE POSITIVES to reject:
- Flag patterns appearing in hex dumps, assembly disassembly, or binary output
- Partial flag fragments that haven't been fully extracted
- Flag format strings in code/config that aren't the actual challenge flag
- The agent discussing what a flag might look like without having found it
- Flag patterns in URL paths, variable names, or documentation

TRUE POSITIVES to accept:
- The agent explicitly states it found the flag and provides the complete string
- The flag appears as the clear result of a successful exploitation
- The agent confirms the flag after submitting it or extracting it from the target`,
        },
        {
          role: "user",
          content: `Analyze this agent output and determine if a CTF flag was genuinely found:\n\n${truncated}`,
        },
      ],
      response_format: zodResponseFormat(FlagDetectionSchema, "flag_detection"),
    });

    const parsed = completion.choices[0]?.message.parsed;
    if (parsed) {
      // Only count high/medium confidence as a real find
      if (parsed.confidence === "low") {
        return { found: false, flag: null, confidence: "low" };
      }
      return parsed;
    }
  } catch (err) {
    console.error("[flag-detector] Dedalus API error:", err);
  }

  return { found: false, flag: null, confidence: "low" };
}
