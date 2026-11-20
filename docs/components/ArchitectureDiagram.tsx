const text = "var(--vocs-text-color-primary)";
const muted = "var(--vocs-text-color-secondary)";
const line = "var(--vocs-border-color-primary)";
const accent = "var(--vocs-color-accent)";
const surface = "var(--vocs-background-color-primary)";
const tint = "var(--vocs-background-color-surfaceTint)";
const mono = "var(--vocs-font-mono)";

const width = 800;
const height = 312;
const boxTop = 40;
const boxHeight = 120;
const boxes = {
  client: { left: 10, right: 170 },
  server: { left: 320, right: 480 },
  chain: { left: 630, right: 790 },
};

function Box(props: {
  left: number;
  right: number;
  top: number;
  height: number;
  title: string;
  lines: { text: string; code?: boolean }[];
  highlight?: boolean;
}) {
  const x = (props.left + props.right) / 2;
  const firstLine =
    props.top +
    props.height / 2 +
    (props.lines.length ? -props.lines.length * 9 : 6);
  return (
    <g>
      <rect
        x={props.left}
        y={props.top}
        width={props.right - props.left}
        height={props.height}
        rx={10}
        style={{
          fill: props.highlight ? tint : surface,
          stroke: props.highlight ? accent : line,
          strokeWidth: 1.5,
        }}
      />
      <text
        x={x}
        y={firstLine}
        textAnchor="middle"
        style={{ fill: text, fontSize: 17, fontWeight: 600 }}
      >
        {props.title}
      </text>
      {props.lines.map((entry, i) => (
        <text
          key={entry.text}
          x={x}
          y={firstLine + 24 + i * 20}
          textAnchor="middle"
          style={{
            fill: muted,
            fontSize: 13,
            fontFamily: entry.code ? mono : undefined,
          }}
        >
          {entry.text}
        </text>
      ))}
    </g>
  );
}

/** A straight arrow from (x1, y1) to (x2, y2), with a head at the end and optionally at the start. */
function Arrow(props: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  both?: boolean;
}) {
  const length = Math.hypot(props.x2 - props.x1, props.y2 - props.y1);
  const ux = (props.x2 - props.x1) / length;
  const uy = (props.y2 - props.y1) / length;
  const head = (x: number, y: number, dx: number, dy: number) =>
    `${x},${y} ${x - dx * 10 - dy * 5},${y - dy * 10 + dx * 5} ${x - dx * 10 + dy * 5},${y - dy * 10 - dx * 5}`;
  return (
    <g>
      <line
        x1={props.x1 + (props.both ? ux * 9 : 0)}
        y1={props.y1 + (props.both ? uy * 9 : 0)}
        x2={props.x2 - ux * 9}
        y2={props.y2 - uy * 9}
        style={{ stroke: text, strokeWidth: 1.5 }}
      />
      <polygon
        points={head(props.x2, props.y2, ux, uy)}
        style={{ fill: text }}
      />
      {props.both && (
        <polygon
          points={head(props.x1, props.y1, -ux, -uy)}
          style={{ fill: text }}
        />
      )}
    </g>
  );
}

/** Two opposing arrows between neighbouring boxes, with a caption for the link. */
function Link(props: {
  from: number;
  to: number;
  forward: string;
  back: string;
  caption: string;
}) {
  const x = (props.from + props.to) / 2;
  const arrow = (y: number, x1: number, x2: number, label: string) => (
    <g>
      <Arrow x1={x1} y1={y} x2={x2} y2={y} />
      <text
        x={x}
        y={y - 8}
        textAnchor="middle"
        style={{ fill: text, fontSize: 13 }}
      >
        {label}
      </text>
    </g>
  );
  return (
    <g>
      {arrow(88, props.from + 6, props.to - 6, props.forward)}
      {arrow(132, props.to - 6, props.from + 6, props.back)}
      <text
        x={x}
        y={154}
        textAnchor="middle"
        style={{ fill: muted, fontSize: 12, fontStyle: "italic" }}
      >
        {props.caption}
      </text>
    </g>
  );
}

/** The parts of a Typewriter app and what passes between them. */
export function ArchitectureDiagram() {
  const serverX = (boxes.server.left + boxes.server.right) / 2;
  const databaseTop = 240;
  return (
    <figure style={{ margin: "24px 0" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="img"
        aria-label="Architecture diagram. The client, your frontend, sends signed mutations to the server over your API and gets state and updates back. The server, your code with Typewriter running inside it, sends settlements to the chain over RPC and reads new blocks from it, and keeps its data in Postgres. The chain runs your contract."
        style={{ fontFamily: "inherit", display: "block" }}
      >
        <text
          x={(boxes.client.left + boxes.server.right) / 2}
          y={22}
          textAnchor="middle"
          style={{ fill: muted, fontSize: 12, letterSpacing: 1 }}
        >
          OFFCHAIN
        </text>
        <text
          x={(boxes.chain.left + boxes.chain.right) / 2}
          y={22}
          textAnchor="middle"
          style={{ fill: muted, fontSize: 12, letterSpacing: 1 }}
        >
          ONCHAIN
        </text>

        <Box
          {...boxes.client}
          top={boxTop}
          height={boxHeight}
          title="Client"
          lines={[
            { text: "your frontend" },
            { text: "typewriter/client", code: true },
          ]}
        />
        <Box
          {...boxes.server}
          top={boxTop}
          height={boxHeight}
          title="Server"
          lines={[{ text: "your code" }, { text: "+ Typewriter" }]}
          highlight
        />
        <Box
          {...boxes.chain}
          top={boxTop}
          height={boxHeight}
          title="Monad"
          lines={[{ text: "your contract" }]}
        />
        <Box
          left={serverX - 70}
          right={serverX + 70}
          top={databaseTop}
          height={60}
          title="Postgres"
          lines={[]}
        />

        <Link
          from={boxes.client.right}
          to={boxes.server.left}
          forward="signed mutations"
          back="state, updates"
          caption="your API"
        />
        <Link
          from={boxes.server.right}
          to={boxes.chain.left}
          forward="settlements"
          back="new blocks"
          caption="RPC"
        />
        <Arrow
          x1={serverX}
          y1={boxTop + boxHeight + 6}
          x2={serverX}
          y2={databaseTop - 6}
          both
        />
      </svg>
    </figure>
  );
}
