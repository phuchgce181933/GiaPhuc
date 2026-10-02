import './Card.css';

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`gp-card ${className}`}>
      {(title || actions) ? (
        <header className="gp-card__head">
          <h2 className="gp-card__title">{title}</h2>
          <div className="gp-card__actions">{actions}</div>
        </header>
      ) : null}
      <div className="gp-card__body">{children}</div>
    </section>
  );
}