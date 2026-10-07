import katex from "katex";
import "katex/dist/katex.min.css";
export default function MathText({ text = "" }) {
  const pieces = String(text).split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g);
  return (
    <span className="pt-math-text">
      {pieces.map((piece, i) => {
        if (!piece.startsWith("$") || piece.length < 3)
          return <span key={i}>{piece}</span>;
        const displayMode = piece.startsWith("$$");
        const value = piece.slice(displayMode ? 2 : 1, displayMode ? -2 : -1);
        return (
          <span
            key={i}
            dangerouslySetInnerHTML={{
              __html: katex.renderToString(value, {
                throwOnError: false,
                trust: false,
                strict: "warn",
                displayMode,
                maxExpand: 500,
                maxSize: 10,
                output: "htmlAndMathml",
              }),
            }}
          />
        );
      })}
    </span>
  );
}
