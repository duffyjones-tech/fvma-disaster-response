function App() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
          <h1 className="text-lg font-semibold tracking-tight text-slate-800">
            FVMA Disaster Response
          </h1>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-12">
        <p className="text-sm font-medium uppercase tracking-wide text-teal-700">
          Florida Veterinary Medical Association
        </p>
        <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
          Welcome
        </h2>
        <p className="mt-4 max-w-xl text-slate-600">
          This app will help coordinate veterinary disaster response. Edit{' '}
          <code className="rounded bg-slate-200 px-1.5 py-0.5 text-sm text-slate-800">
            src/App.jsx
          </code>{' '}
          to build the next screen.
        </p>
      </main>
    </div>
  )
}

export default App
