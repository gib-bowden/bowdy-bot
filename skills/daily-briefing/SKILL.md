---
name: daily-briefing
description: Morning briefing workflow — compile today's events, pending tasks, and upcoming deadlines into a concise summary
---

# Daily Briefing Skill

## When to Trigger

Activate this workflow when the user asks for:
- "morning briefing"
- "what's on today"
- "daily update"
- "what do I have going on"
- "brief me"

## Briefing Structure

Compile the briefing in this order:

### 1. Today's Calendar
- Fetch today's events using `calendar_list_events`
- List events chronologically with times
- Flag any back-to-back meetings or tight transitions
- Note gaps/free time blocks

### 2. Pending Tasks
- Fetch incomplete tasks from the general list
- Highlight any tasks that feel time-sensitive based on their description
- Keep the list concise — if there are many, show the top 5 and mention the total count

### 3. Grocery Status
- If there are items on the grocery list, mention the count: "You have X items on your grocery list"
- Don't list individual grocery items unless asked

## Formatting

Keep it conversational and scannable:
- Use short bullet points
- Lead with the most important/time-sensitive items
- End with a friendly sign-off ("Have a great day!" or similar)

## Example Output Shape

> Good morning! Here's your day:
>
> **Calendar:**
> - 9:00 AM — Team standup
> - 12:30 PM — Lunch with Sarah
> - 3:00 PM — Dentist appointment
>
> **Tasks:**
> - Pick up dry cleaning
> - Call plumber about kitchen sink
> - 3 more tasks on your list
>
> **Groceries:** 7 items on your shopping list
>
> Looks like a busy day — don't forget about the dentist at 3!
