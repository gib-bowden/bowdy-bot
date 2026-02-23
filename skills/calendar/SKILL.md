---
name: calendar-management
description: Patterns for managing Google Calendar events — conflict checking, timezone handling, natural date interpretation, and event conventions
---

# Calendar Management Skill

## Before Creating Events

Always check for conflicts before creating a new event:

1. List events for the target date/time range using `calendar_list_events`
2. If conflicts exist, inform the user and suggest alternatives
3. Only create after confirming the time slot works

## Timezone Handling

- The family's timezone is set in the system prompt — always use it for interpreting times
- When a user says "tomorrow at 2pm", interpret that in the family timezone
- For events with attendees in other timezones, note the timezone explicitly

## Natural Date Interpretation

- "this weekend" = upcoming Saturday and Sunday
- "next week" = the Monday–Sunday after the current week
- "tomorrow morning" = next day, ~8:00 AM
- "tomorrow afternoon" = next day, ~12:00 PM
- "tonight" = today, ~7:00 PM
- "end of day" = today, ~5:00 PM

## Event Naming Conventions

- Use clear, concise titles: "Dentist - Dr. Smith" not "Appointment"
- Include the person's name if it's specific to one family member: "Soccer practice (kid's name)"
- For recurring family events, keep titles consistent

## Duration Defaults

- Meetings: 1 hour unless specified
- Appointments (doctor, dentist): 1 hour
- Quick calls: 30 minutes
- All-day events: flag as all-day rather than setting 24-hour duration

## Recurring vs One-Off

- Ask the user if an event should recur when it sounds habitual ("soccer practice", "piano lesson")
- One-off events: birthday parties, doctor appointments, specific meetings
- When in doubt, create as one-off and ask if they want it recurring
