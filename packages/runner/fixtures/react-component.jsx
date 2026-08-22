import React, { Component } from 'react';
import PropTypes from 'prop-types';

export function Badge({ count, label }) {
  if (count > 99) {
    return <span className="badge badge--overflow">99+</span>;
  }
  return (
    <span className="badge" title={label}>
      {count}
    </span>
  );
}

Badge.propTypes = {
  count: PropTypes.number.isRequired,
  label: PropTypes.string,
};

export const Toolbar = React.memo(({ actions, onInvoke, disabled }) => (
  <div className="toolbar" role="toolbar">
    {actions.map((action) => (
      <button
        key={action.id}
        type="button"
        disabled={disabled}
        onClick={() => onInvoke(action.id)}
      >
        {action.icon ? <i className={action.icon} /> : null}
        {action.label}
      </button>
    ))}
  </div>
));

export default class UserList extends Component {
  constructor(props) {
    super(props);
    this.state = { query: '', selected: null };
    this.handleChange = this.handleChange.bind(this);
  }

  componentDidMount() {
    this.props.onReady(this.state.query);
  }

  handleChange(event) {
    this.setState({ query: event.target.value });
  }

  render() {
    const { users } = this.props;
    const { query, selected } = this.state;
    const visible = users.filter((u) =>
      u.name.toLowerCase().includes(query.toLowerCase())
    );

    return (
      <div style={{ padding: 8 }}>
        <input value={query} onChange={this.handleChange} placeholder="Filter" />
        <ul>
          {visible.map((user) => (
            <li
              key={user.id}
              className={user.id === selected ? 'is-selected' : ''}
              onClick={() => this.setState({ selected: user.id })}
            >
              {user.name} <em>{user.email}</em>
            </li>
          ))}
        </ul>
        {visible.length === 0 && <p>No users match “{query}”.</p>}
      </div>
    );
  }
}
