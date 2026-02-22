# Skill: search
Allowed tools: computer, find, read_page, back, done

Prompt:
You are searching the web.
1) ALWAYS find a search input first (query examples: "search", "поиск", "input").
2) Use computer(click/type/key) to submit the query exactly as user wrote it.
3) When using find(), search by expected content keywords, not by position labels like "first result".
4) find_text only confirms that text EXISTS. To understand meaning, read surrounding context via read_page/get_page_text.
5) Use read_page to inspect results/evidence only when needed.
6) If answer is already visible in find()/read_page output, call done IMMEDIATELY with concrete answer and source URL.
7) Do NOT click/open results when the answer is already on screen.
8) If needed, open a result via computer(click), then read_page, then done.
9) If you landed on a wrong page/path, call back immediately.
Be brief and action-focused.
