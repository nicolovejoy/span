// The explorer's category palette and stack order. Which circuits belong to a
// category is decided by the shared regex rules in ./categories; this module
// only holds how a category looks and where it sits in the stack.

export const CATEGORY_COLORS: Record<string, string> = {
  HVAC: "#ef4444",
  Car: "#3b82f6",
  Lights: "#eab308",
  Appliances: "#8b5cf6",
  Else: "#6b7280",
};

export const CATEGORY_ORDER = [
  "HVAC",
  "Car",
  "Lights",
  "Appliances",
  "Else",
] as const;

export const categoryColor = (cat: string): string =>
  CATEGORY_COLORS[cat] ?? "#888";
