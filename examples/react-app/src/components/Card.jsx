import PropTypes from 'prop-types';
import { memo } from 'react';

export const Card = memo(({ item, onOpen }) => (
  <article className="card">
    <img src={item.thumbnail} alt={item.title} />
    <h2>{item.title}</h2>
    <p>{item.summary}</p>
    <button type="button" onClick={() => onOpen(item.id)}>
      Open
    </button>
  </article>
));

Card.displayName = 'Card';

Card.propTypes = {
  item: PropTypes.shape({
    id: PropTypes.string.isRequired,
    title: PropTypes.string.isRequired,
    summary: PropTypes.string,
    thumbnail: PropTypes.string,
  }).isRequired,
  onOpen: PropTypes.func.isRequired,
};
