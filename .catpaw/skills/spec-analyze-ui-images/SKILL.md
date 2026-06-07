---
name: spec-analyze-ui-images
description: Triggered only when user provides UI interface images. Systematically analyze UI images from PRD or design mockups to extract key information about terminal, layout, components, interactions, content, and states, providing design guidance for subsequent design.md writing and page implementation.
---

## Overview

Conduct in-depth analysis of UI images provided by users (design mockups, PRD screenshots, etc.) to extract design intent and interaction logic, providing guidance for subsequent technical design and implementation.

## Analysis Dimensions

### 1. Terminal Identification
- **PC**: Typically features larger screen size and horizontal content display
- **App**: Mobile-specific characteristics, usually with bottom navigation bar, rounded corners, and decorative styles
- **PDA**: Simplified mobile version with no rounded corners or decorative styles, clean interface design

### 2. Layout Structure
- Overall page structure: distribution of headers, main content area, footers, etc.
- Layout nesting relationships
- Content grouping relationships
- Content alignment within each area

### 3. Component Identification
Record all components used on the page and their characteristics:

**Common Components**:
- Buttons:
  - Button positioning
  - Button types:
    - Primary Action Button: filled background color
    - Secondary Action Button: bordered without fill
    - Text Button: no border and no background
- Input fields, text areas, dropdowns, checkboxes, radio buttons
- Tags, badges, progress bars

**Data Display Components**:
- Tables: including headers, row data, action columns, etc.
- Cards: information display, data summary, etc.
- Lists: data lists, tree structures, etc.
- Field grouping: information display organized by categories

**Selector Components**:
- Date Picker vs Date Range Picker
  - Date Picker: single input field for selecting a single date
  - Date Range Picker: 2 input fields connected by "-" or "~"
- Cascading selectors, tree selectors, search selectors, etc.

**Feedback Components**:
- Modals, pop-ups, drawers
- Alert boxes, warning boxes, confirmation boxes
- Loading animations, empty states, error messages

### 4. Interaction Behavior
- User operation paths: clicking, typing, selecting, searching, etc.
- Page navigation or switching logic
- Display/hide rules for modals, overlays, dropdown menus
- Form submission, data refresh, pagination interactions
- Permission-related interaction variations

### 5. Content Information
- Table column names, form labels, button text
- Page titles, section headings
- Form validation messages, error messages, etc.

### 6. State Information
- Normal State: page loaded successfully, data displayed normally
- Empty State: display scheme when no data is available
- Loading State: indication during data loading
- Error State: indication when loading or operation fails
- Disabled State: disabled state of buttons or form items
- Selected State: selected state of table rows, cards, tags, etc.

### 7. Multi-Image Relationships
If user provides multiple images, or one image contains multiple interfaces, analyze:
- Information correlation relationships between interfaces
- Pre/post relationships in flows, or primary/secondary relationships, branch flows

## Analysis Output

After analysis, produce a structured analysis report including:

1. **Terminal and Page Type**: clearly identify PC/App/PDA and page types such as list/create-edit/detail/report pages
2. **Layout Overview**: brief description of overall layout structure
3. **Component Inventory**: enumerate all components
4. **Interaction Flow**: describe main user operation flows
5. **Content and States**: record key text and state displays
6. **Design Constraints**: extract any design limitations or special requirements that affect implementation

## Association with design.md

Analysis output directly guides the writing of `design.md`:
- Page information section (terminal, page type, etc.)
- Page layout area implementation
- Definition of form fields and table columns
- Action buttons and interaction rules
- Page state handling scheme

**Content Conflict Resolution Principle**: When image content information conflicts with other text content provided by the user, prioritize the text content.
