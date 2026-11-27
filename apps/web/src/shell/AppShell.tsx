import { useState, type ReactNode } from "react";

export interface Screen {
  id: string;
  /** The word under the icon. */
  label: string;
  /** An SVG path on a 24 × 24 grid, drawn as an outline. */
  icon: string;
  /** Keep the screen as it was left; otherwise it loads afresh each time it is opened. */
  keepOpen?: boolean;
  render: (go: (id: string) => void) => ReactNode;
}

/** One screen at a time, with the others a thumb's reach away along the bottom. */
export function AppShell({ screens }: { screens: Screen[] }) {
  const [current, setCurrent] = useState(screens[0]?.id);
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());

  const go = (id: string) => {
    if (id === current) return;
    if (current) setLeft((before) => new Set(before).add(current));
    setCurrent(id);
    document.documentElement.scrollTop = 0;
  };

  return (
    <>
      {screens.map((screen) => {
        const shown = screen.id === current;
        if (!shown && !(screen.keepOpen && left.has(screen.id))) return null;
        return (
          <div key={screen.id} hidden={!shown}>
            {screen.render(go)}
          </div>
        );
      })}
      <nav className="tab-bar" aria-label="Main">
        {screens.map((screen) => (
          <button key={screen.id} type="button" aria-current={screen.id === current ? "page" : undefined} onClick={() => go(screen.id)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={screen.icon} />
            </svg>
            {screen.label}
          </button>
        ))}
      </nav>
    </>
  );
}
