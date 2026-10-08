import type { Category } from "@buzz/shared";

/**
 * PLACEHOLDER clue set.
 *
 * Roadmap step 5 replaces this with a 6×5 board loaded from a JSON file plus
 * Daily Double / Final Jeopardy. It exists now only so the room state machine
 * is playable end to end.
 */
const RAW: Array<{ category: string; clues: Array<[number, string, string]> }> = [
  {
    category: "Scaffolding",
    clues: [
      [200, "This package holds the socket event contract shared by server and client.", "What is @buzz/shared?"],
      [400, "This Node runner executes TypeScript directly for the server.", "What is tsx?"],
    ],
  },
  {
    category: "Buzzing",
    clues: [
      [200, "The server orders simultaneous buzzes by this, never the client clock.", "What is arrival order?"],
      [400, "This player-only phase is the only one where a buzz is accepted.", "What is BUZZING_OPEN?"],
    ],
  },
];

export function createPlaceholderBoard(): Category[] {
  return RAW.map((category, ci) => ({
    title: category.category,
    clues: category.clues.map(([value, question, answer], qi) => ({
      id: `c${ci}-q${qi}`,
      value,
      question,
      answer,
      revealed: false,
      consumed: false,
      answeredBy: null,
      answeredCorrectly: null,
    })),
  }));
}
