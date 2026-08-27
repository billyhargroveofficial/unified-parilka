import type { BenchmarkScenario, BenchmarkScenarioId } from "./contracts.js";

/**
 * Small, public-only prompts. Keep them static: benchmark reports carry only
 * their stable identifiers, never these inputs or provider output.
 */
const SCENARIOS: readonly BenchmarkScenario[] = Object.freeze([
  {
    id: "ordinary",
    prompt: "Ответь одним коротким предложением: что означает HTTP 404?",
  },
  {
    id: "web",
    prompt: "Проверь через веб-поиск текущую официальную страницу документации Node.js и кратко назови её.",
    hostedWebPolicy: "required_first_leg",
  },
  {
    id: "fetch",
    prompt: [
      "Через веб-поиск найди официальную страницу Node.js про актуальный релиз, затем открой эту страницу.",
      "После web search и open_page дай ровно два коротких предложения на русском только по этой странице.",
    ].join(" "),
    hostedWebPolicy: "required_first_leg",
  },
  {
    id: "research",
    prompt: [
      "Проведи через веб ограниченный research: Infiniti FX37 2012–2013 в РФ в августе 2026.",
      "Нужны отдельные evidence actions по текущим ценам и рынку, рискам владения, стоимости обслуживания и независимому сравнению.",
      "После исследования дай короткий практический ответ на русском с оговорками и источниками.",
    ].join(" "),
    hostedWebPolicy: "bounded_research",
  },
]);

export function scenarioById(id: BenchmarkScenarioId): BenchmarkScenario {
  const scenario = SCENARIOS.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error("Unknown benchmark scenario.");
  return scenario;
}

export function allScenarioIds(): readonly BenchmarkScenarioId[] {
  return SCENARIOS.map((scenario) => scenario.id);
}
