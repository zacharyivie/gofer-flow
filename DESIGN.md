---
name: Taskurotta Studio
description: A compact local workflow cockpit built around the graph.
colors:
  primary: "#4f46e5"
  canvas: "#fafafa"
  sidebar: "#f7f7f8"
  surface: "#ffffff"
  surface-muted: "#f4f4f5"
  ink: "#1c1c1f"
  muted: "#71717a"
  line: "#e4e4e7"
  success: "#059669"
  warning: "#d97706"
  error: "#dc2626"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.25
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
  full: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
    height: "34px"
    padding: "0 12px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 12px"
---

# Design System: Taskurotta Studio

## Overview

**Creative North Star: "The Local Workflow Cockpit"**

The graph is the workspace, not a card inside a dashboard. Navigation and assistance frame it with compact, predictable tools. Zinc neutrals keep long sessions calm, while indigo marks selection, focus, and the primary action.

The interface is dense enough for builders but uses plain labels and familiar controls so workflow authors do not need to know the TOML model first.

**Key Characteristics:**

- Three-pane desktop composition with a dominant center canvas
- Contextual floating UI for maps, menus, and configuration
- One accent color plus semantic run-state colors
- Light and dark palettes with matching hierarchy

## Colors

Indigo is the only general accent. Green, amber, red, and blue are reserved for actual state.

**The One Accent Rule.** Use indigo for selection, focus, and primary actions. Do not introduce another brand accent.

## Typography

The studio uses the operating system's UI sans stack. Monospace is reserved for code, paths, identifiers, logs, and measurements.

The hierarchy stays compact: 14px titles, 13px body copy, 11px supporting labels, and 10px metadata where space is tight.

## Layout

The default desktop layout uses a 272px workflow rail, a flexible graph canvas, and a 380px assistant pane. Each side pane remains resizable. Headers are 54px high and stay to one row. The inspector overlays the canvas and appears only when requested or when a node opens.

Floating canvas controls must keep 16px from the viewport edge and move clear of the inspector. The application targets desktop windows and keeps keyboard access for every graph action.

## Elevation & Depth

Base panes are flat and separated by one-pixel lines. Shadows belong to floating surfaces such as popovers, nodes, dialogs, and the inspector.

**The Flat Frame Rule.** Fixed navigation and headers use tonal separation or a border. They do not cast shadows.

## Shapes

Standard controls use 6px corners. Nodes and compact surfaces use 10px corners. Popovers and the composer use 14px corners. Pills are limited to badges, status chips, and the combined model trigger.

## Components

### Buttons

Primary buttons use indigo with white text. Quiet icon buttons start borderless and gain a muted background on hover. Focus uses a visible two-pixel indigo outline.

### Chips

Chips are small pills with a tinted surface. Their text and border share the same semantic hue.

### Cards / Containers

Persistent panes are not cards. Popovers use a 14px corner, a one-pixel neutral border, and a soft offset shadow.

### Inputs / Fields

Inputs use a white or dark-surface fill and a neutral border. Focus shifts the border to indigo and may add a restrained translucent ring.

### Navigation

Workflow groups use collapsible folder rows. The selected workflow receives an indigo tint without an extra border. Thread history lives in a popover opened from the assistant header.

### Graph map

Outline and minimap share one bottom-right Map popover. The popover defaults closed and uses tabs so both views never compete for canvas space.

## Do's and Don'ts

### Do:

- **Do** keep the graph readable before adding secondary controls.
- **Do** expose status with text or an accessible label, not color alone.
- **Do** keep the assistant composer available even when no thread is open.

### Don't:

- **Don't** stack multiple permanent panels over the canvas.
- **Don't** use native selects for provider and model discovery when grouped availability matters.
- **Don't** add explanatory wireframe notes to the product UI.
