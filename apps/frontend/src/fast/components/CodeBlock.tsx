import { useEffect, useState } from "react";
import { codeToHtml } from "shiki";

export function CodeBlock({
  code,
  lang = "typescript",
  title,
}: {
  code: string;
  lang?: string;
  title?: string;
}) {
  const [html, setHtml] = useState("");

  useEffect(() => {
    codeToHtml(code.trim(), {
      lang,
      theme: "github-dark-default",
    }).then(setHtml);
  }, [code, lang]);

  return (
    <div className="rounded-lg border overflow-hidden my-4">
      {title && (
        <div className="bg-zinc-800 text-zinc-300 text-xs px-4 py-2 border-b border-zinc-700 font-mono">
          {title}
        </div>
      )}
      <div
        className="text-sm [&_pre]:p-4 [&_pre]:overflow-x-auto [&_pre]:m-0"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki outputs sanitized HTML
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
