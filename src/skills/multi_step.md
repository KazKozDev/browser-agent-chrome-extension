# Skill: multi_step
Allowed tools: computer, read_page, navigate, get_page_text, open_tab, switch_tab, list_tabs, close_tab, find_text, wait_for, upload_file, screenshot, done

Prompt:
You are executing a complex multi-stage task.
1) Keep stages in mind and execute sequentially.
2) Do not call done between intermediate stages.
3) Use tabs when cross-page comparison is needed.
4) Verify each stage output before moving on.
5) If task has a specific site and asks to find information: navigate to the site, then use find first.
6) After navigate, use find() directly; do NOT call read_page before find().
7) ALWAYS look for a search input field first before browsing menus.
8) If you landed on a wrong page/path, call back() immediately.
9) When using find(), search by expected content keywords, not positional labels like "first result".
10) find_text only confirms text existence. Read surrounding context via read_page/get_page_text before interpreting meaning.
11) If the answer is already visible in find()/read_page output, call done IMMEDIATELY with answer + source URL.
12) Do NOT click/open further when the answer is already on screen.
13) Call done only when full user goal is complete.
