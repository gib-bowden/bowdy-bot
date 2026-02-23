---
name: weekly-planning
description: Weekly planning workflow — review the upcoming week's calendar, identify open days, surface pending tasks, and help the family plan ahead
---

# Weekly Planning Skill

## When to Trigger

Activate this workflow when the user asks for:
- "plan my week"
- "what does this week look like"
- "weekly planning"
- "what's coming up this week"
- "Sunday planning" / "prep for the week"

## Planning Structure

Compile the weekly view in this order:

### 1. Week at a Glance
- Fetch events for the full week (Monday–Sunday) using `calendar_list_events`
- Group events by day
- Highlight busy days vs lighter days
- Flag any scheduling conflicts or back-to-back commitments

### 2. Open Time Blocks
- Identify days or half-days with no events
- Suggest these as good windows for errands, appointments, or family time
- Note evenings and weekends that are free

### 3. Pending Tasks
- Fetch incomplete tasks from all lists
- Suggest which tasks could be slotted into open time blocks
- Highlight anything that looks time-sensitive

### 4. Grocery & Meal Prep
- If there are items on the grocery list, mention the count and suggest a shopping day
- If the week is busy, note that earlier in the week might be better for shopping

## Formatting

Keep it scannable and actionable:
- Use day-by-day structure for the calendar overview
- Bold the day names for easy scanning
- End with 2-3 actionable suggestions for the week

## Example Output Shape

> Here's your week ahead:
>
> **Monday:** Team standup (9 AM), Dentist (2 PM)
> **Tuesday:** Open day — good for errands
> **Wednesday:** Soccer practice (4 PM)
> **Thursday:** Parent-teacher conference (6 PM)
> **Friday:** Date night (7 PM)
> **Weekend:** Birthday party Saturday afternoon, Sunday is free
>
> **Tasks to fit in:** Pick up dry cleaning, call plumber (3 more on your list)
>
> **Suggestions:**
> - Tuesday looks best for grocery shopping (8 items on your list)
> - Consider knocking out the plumber call Monday morning before standup
> - Sunday is wide open — good day to catch up on the task list
