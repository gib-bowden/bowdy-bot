---
name: tasks
description: Patterns for managing tasks and grocery lists — organization, completion workflows, categorization, and cleanup
---

# Task & Grocery List Management Skill

## List Organization

Tasks are organized into lists:

- **general** — the default for nearly everything: todos, chores, reminders, errands, projects
- **grocery** — shopping items only

Default to **general** for anything that isn't groceries. Don't create custom lists unless the user explicitly asks for one (e.g., "make me a packing list for our trip"). Even then, confirm before creating it.

Never ask which list — make your best guess and always mention which list you added to in your reply (e.g., "Added paper towels to your grocery list" or "Added 'fix fence' to your general list"). This way the user can quickly correct if needed.

## Completing vs Deleting

- **Complete** a task when the user finished it: "done with X", "finished X", "got it", "picked up X"
- **Delete** a task when it was a mistake, duplicate, or needs to move: "remove X", "that's on the wrong list", "delete X", "nevermind about X"
- To move a task between lists: delete from the old list, then add to the new one
- After completing or deleting, briefly confirm what happened

## Bulk Operations

- "Clear the grocery list" — mark all grocery items complete
- "What's left?" — show only incomplete items
- "Add milk, eggs, and bread" — create multiple items from a comma-separated list

