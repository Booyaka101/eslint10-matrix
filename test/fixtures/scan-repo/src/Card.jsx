import { Suspense, lazy, useState } from 'react';

const Details = lazy(() => import('./Details.jsx'));

export function Card({ item }) {
  const [open, setOpen] = useState(false);

  return (
    <article className="card">
      <h2>{item.title}</h2>
      <button type="button" onClick={() => setOpen(!open)}>
        {open ? 'Hide' : 'Show'} details
      </button>
      {open ? (
        <Suspense fallback={<p>Loading</p>}>
          <Details id={item.id} />
        </Suspense>
      ) : null}
    </article>
  );
}
