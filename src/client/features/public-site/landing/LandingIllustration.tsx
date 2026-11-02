export function LandingIllustration() {
  return (
    <figure className="workspace-preview" aria-labelledby="preview-heading">
      <figcaption className="preview-bar">
        <span>↗ SEO PILOT / THE DIRECTION</span>
        <span>Product map · not live data</span>
      </figcaption>
      <div className="preview-layout">
        <div className="preview-sidebar" aria-hidden="true">
          <span>◉ Overview</span>
          <span>⌁ Site health</span>
          <span>↗ Search intelligence</span>
          <span>◎ AI visibility</span>
          <span>▤ Content &amp; review</span>
          <span>↻ Daily routines</span>
        </div>
        <div className="preview-content">
          <h2 id="preview-heading">A clearer picture. A better next step.</h2>
          <p>From an open-source foundation to one connected workspace.</p>
          <div className="preview-steps">
            <div>
              <span className="step-label">Understand</span>
              <strong>Find the evidence</strong>
              <span>Audits &amp; research</span>
            </div>
            <div>
              <span className="step-label">Create</span>
              <strong>Shape the next change</strong>
              <span>Content studio · planned</span>
            </div>
            <div>
              <span className="step-label">Review</span>
              <strong>Keep control</strong>
              <span>Publishing flow · planned</span>
            </div>
          </div>
        </div>
      </div>
    </figure>
  );
}
