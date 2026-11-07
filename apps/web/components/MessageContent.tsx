import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders a message's content as markdown — every provider's reply is prose, not
 * plain text, and showing literal `**bold**`/code fences instead of rendering them
 * is the single biggest gap between this and any mainstream chat UI. `code`/`pre`
 * are overridden to match the block styling already used elsewhere in this app
 * (`AttemptPanel`'s tool-call blocks) rather than the typography plugin's own
 * defaults, so a code block looks the same wherever it appears.
 */
export default function MessageContent({ content }: { content: string }): React.JSX.Element {
  return (
    <div className="prose prose-sm max-w-none break-words leading-relaxed prose-neutral dark:prose-invert prose-p:my-2 prose-pre:my-2 prose-headings:mb-2 prose-headings:mt-4 prose-headings:font-semibold">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => <a {...props} target="_blank" rel="noreferrer noopener" />,
          code: ({ className, children, ...props }) => {
            // A fenced block with no language tag gets no `language-*` class at
            // all — multi-line content is the reliable fallback signal for those.
            const isBlock =
              className?.includes('language-') === true || String(children).includes('\n');
            if (!isBlock) {
              return (
                <code
                  className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[0.85em] before:content-none after:content-none dark:bg-neutral-800"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-md bg-neutral-100 p-3 text-xs dark:bg-neutral-900">
              {children}
            </pre>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
