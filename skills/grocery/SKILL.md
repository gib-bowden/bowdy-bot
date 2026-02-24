---
name: Grocery Shopping
description: Manage the family grocery list with Kroger product search and pricing
tools:
  - search_kroger_products
  - add_to_grocery_list
  - list_grocery_items
  - remove_grocery_item
  - check_grocery_item
  - clear_grocery_list
  - set_kroger_store
---

# Grocery Shopping Workflow

## Store Setup

Before searching products or adding items, ensure a preferred store is set:

1. Check if the user has a store configured (search will fail with a clear error if not)
2. If no store is set, ask the user for their zip code
3. Use `set_kroger_store` to find nearby stores and let the user pick one

## Adding Items

When the user says "add X to the grocery list":

1. Use `search_kroger_products` to find the item at their store
2. If one clear match, add it directly with `add_to_grocery_list` using the `product_id`
3. If multiple reasonable options (e.g., different brands of milk), briefly confirm with the user which they prefer
4. If the item is vague (e.g., "milk"), prefer common/popular options — whole milk gallon, etc.
5. Default quantity to 1 unless the user specifies otherwise

## Recipe Handling

When the user says "I need stuff for [recipe]":

1. Break the recipe into individual grocery items
2. Search and add each one, grouping results in a single response
3. Skip common pantry staples (salt, pepper, oil) unless the user asks for them

## Viewing the List

When showing the grocery list:

- Use `list_grocery_items` to get all unchecked items
- Present items grouped logically (produce, dairy, meat, etc. if possible)
- Always show the estimated total at the bottom

## Checking Off Items

- Use `check_grocery_item` to toggle items as the user shops
- Partial name matching is supported — "milk" will match "Kroger Whole Milk"

## Clearing the List

- Always preview first (call without confirm) so the user sees what will be deleted
- Only clear with confirm=true after the user agrees
