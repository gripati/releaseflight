"use client";
import { useEffect, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import type { ScreenshotRow } from "./ScreenshotsPanel";

interface Props {
  items: ScreenshotRow[];
  renderCard: (s: ScreenshotRow, dragHandle: React.ReactNode) => React.ReactNode;
  onCommit: (newOrder: string[]) => void;
}

export function SortableGrid({ items, renderCard, onCommit }: Props): JSX.Element {
  const [activeId, setActiveId] = useState<string | null>(null);

  // dnd-kit derives `aria-describedby` IDs from a module-level counter
  // (DndDescribedBy-0, -1, -2…). The server and client increment that
  // counter independently → hydration mismatch on every drag handle.
  //
  // Fix: only render the DndContext after mount. The grid still SSR-renders
  // the static <ul> shell from the second branch below, so the user gets
  // an instant first-paint and the interactive drag layer attaches a tick
  // later without any visible jump.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (!mounted) {
    // Static, dnd-free server-render: shows every card immediately but
    // without the drag handle wiring. Identical CSS so there's zero
    // layout shift when the interactive version takes over.
    return (
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
        {items.map((item) => (
          <li key={item.id}>{renderCard(item, null)}</li>
        ))}
      </ul>
    );
  }

  function handleDragStart(e: DragStartEvent): void {
    setActiveId(String(e.active.id));
  }

  function handleDragEnd(e: DragEndEvent): void {
    setActiveId(null);
    if (!e.over || e.active.id === e.over.id) return;
    const oldIndex = items.findIndex((i) => i.id === e.active.id);
    const newIndex = items.findIndex((i) => i.id === e.over!.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const newOrder = arrayMove(items, oldIndex, newIndex).map((i) => i.id);
    onCommit(newOrder);
  }

  const activeItem = activeId ? items.find((i) => i.id === activeId) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={items.map((i) => i.id)} strategy={rectSortingStrategy}>
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
          {items.map((item) => (
            <SortableItem key={item.id} id={item.id}>
              {(handle) => <li>{renderCard(item, handle)}</li>}
            </SortableItem>
          ))}
        </ul>
      </SortableContext>
      <DragOverlay>
        {activeItem ? (
          <div className="aspect-[9/16] w-full max-w-[180px] overflow-hidden rounded-[var(--radius)] border border-[var(--signal)] bg-[var(--surface-elevated)] opacity-90 shadow-[var(--shadow-modal)]">
            {/* The overlay is a visual hint — drag uses the underlying card */}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function SortableItem({
  id,
  children,
}: {
  id: string;
  children: (handle: React.ReactNode) => React.ReactNode;
}): JSX.Element {
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  const dragHandle = (
    <button
      type="button"
      aria-label="Drag to reorder"
      className="grid h-5 w-5 place-items-center rounded-[var(--radius-xs)] text-[var(--ink-tertiary)] hover:bg-[var(--surface-tinted)] hover:text-[var(--ink-primary)]"
      {...attributes}
      {...listeners}
    >
      <GripVertical size={12} />
    </button>
  );
  return (
    <div ref={setNodeRef} style={style}>
      {children(dragHandle)}
    </div>
  );
}
