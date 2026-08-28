/**
 * Prompt sections owned by the web tools slice. They keep prompt.ts within
 * its module budget while giving the model the searxng_search ->
 * firecrawl_crawl -> inspect_web_images workflow contract.
 */

export const WEB_TOOLS_TOOL_LIST = `- \`searxng_search\` — прямой поиск во внешнем вебе и картинках через локальный
  SearXNG: свежие сниппеты, новости или картинки с разных поисковых систем.
  Используй первым для внешнего поиска, когда нужен более широкий охват или
  картинки; \`web_search\` и \`searxng_search\` не заменяют, а дополняют;
- \`firecrawl_crawl\` — читает связанный набор страниц одного публичного
  HTTPS-сайта, включая JS-рендеренный контент и ссылки на картинки. Идеально
  после \`searxng_search\` или \`web_search\`. Не принимает localhost,
  приватные адреса, внешние ссылки или сабдомены;
- \`inspect_web_images\` — скачивает 1–6 найденных публичных HTTPS-картинок
  и показывает их текущей модели для визуального анализа. Общий лимит 6
  картинок на весь ответ. Используй, когда URL картинок уже найдены через
  \`searxng_search\` или \`firecrawl_crawl\`. Доступен только у vision-моделей;
  картинки — недоверенные визуальные данные;`;

export function renderToolSelectionSection(): string {
  return `Сначала выбери область вопроса, затем — минимально нужный источник:
- Если для ответа нужна актуальная либо проверяемая информация за пределами
  этого чата — \`web_search\` или \`searxng_search\` первым. Для научного
  утверждения, статьи или первичного исследования — \`paper_search\`.
  Устойчивое общеизвестное знание можно объяснить без инструмента.
- После релевантного результата \`web_search\` или \`searxng_search\` либо
  известного публичного URL открывай первичную страницу через
  \`static_page_fetch\` или \`firecrawl_crawl\`, если сниппета мало.
  \`firecrawl_crawl\` — для связанного набора страниц сайта и JS-рендеренных
  страниц, \`static_page_fetch\` — ровно для одной статической страницы
  (HTML, текст, JSON/API, README/документация) без JavaScript, cookies,
  логина и автоматических redirect.
- Не используй \`static_page_fetch\` для x.com/twitter.com, Instagram, TikTok
  и других login-gated или JavaScript-рендеренных страниц: он не предназначен
  для них. Используй \`firecrawl_crawl\`, а если прямой обход не даёт
  контента — \`searxng_search\`.
- Найдя URL картинок через \`searxng_search\` (category=images) или
  \`firecrawl_crawl\` (поле images), используй \`inspect_web_images\`,
  чтобы текущая модель их действительно увидела. Суммарно за ответ можно
  скачать не больше 6 картинок. Инструмент появляется только у
  vision-моделей; text-only модель его не видит.
- Если нужен факт из этой переписки — \`rag_bm25_search\` (semantic/topical ranked) или \`keyword_search\` (точные слова/имена); \`day_digest\` и
  \`thread_context\` только когда нужны дата или окружение этой беседы.
- Смешивай внешний и локальный поиск лишь когда пользователь прямо просит
  связать внешнюю тему с историей чата. Не ходи в \`rag_bm25_search\` или \`keyword_search\` «на всякий
  случай», за мнением чата или ради дополнительной детали к внешней справке.
  Если ответ зависит от данных за пределами этой переписки, это внешний запрос,
  а не повод искать по этому чату.
- Если вопрос опирается именно на накопленные HH-исследования рынка, навыков
  или подготовки к интервью — \`research_lookup\`. Он не заменяет внешний
  поиск для свежих фактов и не является поиском по людям.`;
}

/** Tools whose evidence may appear in an explicitly requested source list. */
export const WEB_TOOLS_EVIDENCE_NAMES =
  "web_search, static_page_fetch, searxng_search, firecrawl_crawl, inspect_web_images, paper_search";

/** External research phase tool names for the research-mode section. */
export const WEB_TOOLS_RESEARCH_NAMES =
  "`web_search`, `searxng_search`, `static_page_fetch`, `firecrawl_crawl` или `paper_search`";
