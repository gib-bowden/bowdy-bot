---
name: Grocery Shopping
description: Manage the family grocery list (Google Tasks) with Kroger product search and cart sync
tools:
  - add_task
  - list_tasks
  - complete_task
  - delete_task
  - search_kroger_products
  - set_kroger_store
  - send_to_kroger_cart
---

# Grocery Shopping Workflow

## Overview

The grocery list lives in **Google Tasks** (list name: "grocery") for easy visibility in the Google Tasks app. **Kroger** provides product search and cart sync — when ready to shop, push all grocery items to the Kroger cart so they appear in the Kroger app.

## Store Setup

Before searching products or syncing to cart, ensure a preferred Kroger store is set:

1. Check if the user has a store configured (search will fail with a clear error if not)
2. If no store is set, ask the user for their zip code
3. Use `set_kroger_store` to find nearby stores and let the user pick one

## Adding Items to the Grocery List

When the user says "add X to the grocery list":

1. Use `add_task` with `list="grocery"` to add the item to Google Tasks
2. If the user wants product/price info, use `search_kroger_products` to look it up — but the list itself lives in Google Tasks

## Recipe Handling

When the user says "I need stuff for [recipe]":

1. Break the recipe into individual grocery items
2. Add each one to the grocery list with `add_task` (list="grocery")
3. Skip common pantry staples (salt, pepper, oil) unless the user asks for them

## Viewing the List

When showing the grocery list:

- Use `list_tasks` with `list="grocery"` to get all unchecked items
- Present items in a clean format

## Completing / Removing Items

- Use `complete_task` to mark items as done while shopping
- Use `delete_task` to permanently remove items

## Sending to Kroger Cart

When the user says "send groceries to Kroger", "I'm ready to shop", or similar:

1. Use `send_to_kroger_cart` — this reads all unchecked grocery items from Google Tasks, searches Kroger for each one, and adds matching products to the Kroger cart
2. Report what was added and any items that couldn't be matched
3. The user can then open the Kroger app to see their cart
