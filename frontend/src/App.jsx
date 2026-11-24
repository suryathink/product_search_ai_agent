import ChatWidget from './ChatWidget.jsx';

// A stand-in product website so the assistant is shown in its real context: a widget on a page.
export default function App() {
  return (
    <div className="site">
      <header className="site-header">
        <div className="site-logo">POWER TOOLS <span>demo storefront</span></div>
        <nav>
          <a>Power Tools</a><a>Measuring</a><a>Accessories</a><a>Batteries</a><a>Support</a>
        </nav>
      </header>
      <main className="site-hero">
        <h1>Find the right tool, faster.</h1>
        <p>
          Ask the product assistant about specs, compatibility, kits vs. bare tools, or what fits your battery
          platform — across Bosch, Dremel, RotoZip and CST/berger.
        </p>
        <div className="site-tiles">
          {['Drills & Drivers', 'Line Lasers', 'Saw Blades', 'Rotary Tools', '18V Batteries', 'L-BOXX Storage'].map((t) => (
            <div key={t} className="site-tile">{t}</div>
          ))}
        </div>
      </main>
      <ChatWidget />
    </div>
  );
}
