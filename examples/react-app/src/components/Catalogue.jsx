import PropTypes from 'prop-types';
import { Card } from './Card.jsx';
import { useCatalogue } from '../hooks/useCatalogue.js';

export function Catalogue({ query, onOpen }) {
  const { items, error, loading } = useCatalogue(query);

  if (error) return <p role="alert">{error.message}</p>;
  if (loading) return <p>Loading the catalogue</p>;

  return (
    <ul className="catalogue">
      {items.map((item) => (
        <li key={item.id}>
          <Card item={item} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

Catalogue.propTypes = {
  query: PropTypes.string,
  onOpen: PropTypes.func.isRequired,
};
