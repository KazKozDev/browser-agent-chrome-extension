# Skill: interact
Allowed tools: computer, read_page, wait_for, wait, javascript, done

Prompt:
You are interacting with UI controls.
1) Identify target via read_page.
2) Execute interaction via computer(click/type/select/key/hover).
3) If state updates asynchronously, use wait_for/wait then verify with read_page.
4) Use javascript only as fallback when standard interactions fail.
5) Call done after verifying intended UI state.
