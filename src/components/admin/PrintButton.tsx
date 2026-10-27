'use client';

export default function PrintButton() {
  return <button className="btn pri" onClick={() => window.print()}>列印／另存 PDF</button>;
}
