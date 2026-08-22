import React, { useId, useState } from 'react';

export function SearchField({ onSubmit }) {
  const inputId = useId();
  const [value, setValue] = useState('');

  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(value);
      }}
    >
      <label htmlFor={inputId}>Search the catalogue</label>
      <input
        id={inputId}
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit">Go</button>
    </form>
  );
}

export function Disclosure({ summary, children }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="disclosure">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((prev) => !prev)}
      >
        {summary}
      </button>
      <div id={panelId} hidden={!open}>
        {children}
      </div>
    </div>
  );
}

export function MediaCard({ item, onOpen }) {
  return (
    <article className="media-card">
      <img src={item.thumbnail} alt={item.altText} width={320} height={180} />
      <h3>
        <a href={item.href}>{item.title}</a>
      </h3>
      <p>{item.summary}</p>
      <div
        className="media-card__overlay"
        onClick={() => onOpen(item.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            onOpen(item.id);
          }
        }}
      />
      <marquee>Featured</marquee>
      <a href="#" onClick={() => onOpen(item.id)}>
        click here
      </a>
      <input type="text" aria-label="" tabIndex="4" />
    </article>
  );
}
