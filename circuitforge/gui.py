"""
Tkinter-based GUI stub for CircuitForge.

This is a *functional stub* — it provides a working entry point but
not a full schematic editor. Its main purposes are:

1. Provide a graphical launcher that the user can run to confirm
   the toolchain is functional.
2. Show the version, license, and a few basic actions: load a
   project, run a logic simulation, show circuit info.

The GUI uses only the standard library (tkinter), so it works
without additional dependencies. A full schematic editor is
considered out of scope for the initial release and is left as
future work (see the spec's roadmap).
"""

from __future__ import annotations

try:
    import tkinter as tk
    from tkinter import ttk, filedialog, messagebox, scrolledtext
except ImportError:
    tk = None  # GUI unavailable on this platform

import threading
import json
import os
from typing import Optional


_APP_TITLE = "CircuitForge"
_APP_VERSION = "0.1.0"


def _version_string() -> str:
    import circuitforge
    return getattr(circuitforge, "__version__", "0.1.0")


class CircuitForgeApp:
    """
    The main application window. Uses Tkinter.
    """

    def __init__(self, root):
        self.root = root
        self.root.title(f"{_APP_TITLE} v{_version_string()}")
        self.root.geometry("900x600")
        self._build_ui()
        self._current_path: Optional[str] = None
        self._current_circuit = None

    def _build_ui(self):
        # Menu bar
        menubar = tk.Menu(self.root)
        filemenu = tk.Menu(menubar, tearoff=0)
        filemenu.add_command(label="Open...", command=self.on_open)
        filemenu.add_command(label="Save", command=self.on_save)
        filemenu.add_separator()
        filemenu.add_command(label="Quit", command=self.root.quit)
        menubar.add_cascade(label="File", menu=filemenu)
        simmenu = tk.Menu(menubar, tearoff=0)
        simmenu.add_command(label="Simulate (logic)", command=self.on_simulate_logic)
        simmenu.add_command(label="Validate", command=self.on_validate)
        menubar.add_cascade(label="Simulate", menu=simmenu)
        helpmenu = tk.Menu(menubar, tearoff=0)
        helpmenu.add_command(label="About", command=self.on_about)
        menubar.add_cascade(label="Help", menu=helpmenu)
        self.root.config(menu=menubar)
        # Layout
        self.paned = ttk.PanedWindow(self.root, orient=tk.HORIZONTAL)
        self.paned.pack(fill=tk.BOTH, expand=True)
        # Left: a treeview of components
        self.tree = ttk.Treeview(self.paned, columns=("ref", "spec"))
        self.tree.heading("#0", text="ID")
        self.tree.heading("ref", text="Reference")
        self.tree.heading("spec", text="Spec")
        self.paned.add(self.tree, weight=1)
        # Right: log / output area
        self.log = scrolledtext.ScrolledText(self.paned, width=60, height=30)
        self.paned.add(self.log, weight=2)
        # Status bar
        self.status = tk.StringVar(value="Ready")
        ttk.Label(self.root, textvariable=self.status, anchor=tk.W,
                   relief=tk.SUNKEN).pack(fill=tk.X)
        self._log(f"{_APP_TITLE} GUI v{_version_string()}")
        self._log("Use File > Open to load a project file (.json).")

    def _log(self, msg: str):
        self.log.insert(tk.END, msg + "\n")
        self.log.see(tk.END)

    def _set_status(self, msg: str):
        self.status.set(msg)
        self.root.update_idletasks()

    def on_open(self):
        path = filedialog.askopenfilename(filetypes=[("JSON", "*.json")])
        if not path:
            return
        try:
            from .io.serialize import project_from_json
            with open(path) as f:
                s = f.read()
            self._current_circuit = project_from_json(s)
            self._current_path = path
            self._populate_tree()
            self._log(f"Loaded: {path}")
            self._set_status(f"Loaded {os.path.basename(path)}")
        except Exception as e:
            messagebox.showerror("Error", str(e))

    def on_save(self):
        if not self._current_circuit:
            messagebox.showwarning("No circuit", "Open a circuit first.")
            return
        path = filedialog.asksaveasfilename(
            defaultextension=".json",
            filetypes=[("JSON", "*.json")],
        )
        if not path:
            return
        try:
            from .io.serialize import project_to_json
            with open(path, "w") as f:
                f.write(project_to_json(self._current_circuit))
            self._log(f"Saved: {path}")
        except Exception as e:
            messagebox.showerror("Error", str(e))

    def on_simulate_logic(self):
        if not self._current_circuit:
            messagebox.showwarning("No circuit", "Open a circuit first.")
            return
        # Run on a worker thread to keep UI responsive
        def worker():
            try:
                from .sim.logic import simulate_logic, LogicState
                from .core.ids import PortId, NetId
                inputs = {}
                for comp in self._current_circuit._components.values():
                    if comp.spec.name == "LOGIC_INPUT":
                        for pid in comp.ports:
                            port = self._current_circuit.ports[PortId(int(pid))]
                            if port.net is not None:
                                try:
                                    self._current_circuit._nets[NetId(int(port.net))].name = comp.reference
                                except KeyError:
                                    pass
                                inputs[comp.reference] = LogicState(1)
                result = simulate_logic(self._current_circuit, inputs)
                self._log(f"Logic simulation: {len(result.net_states)} nets driven")
                for comp in self._current_circuit._components.values():
                    if comp.spec.name == "LOGIC_OUTPUT":
                        for pid in comp.ports:
                            port = self._current_circuit.ports[PortId(int(pid))]
                            if port.net is not None:
                                v = result.net_states.get(int(port.net), LogicState.LOGIC_X)
                                self._log(f"  {comp.reference}: {v.name}")
            except Exception as e:
                self._log(f"Simulation error: {e}")
        threading.Thread(target=worker, daemon=True).start()
        self._set_status("Simulating…")

    def on_validate(self):
        if not self._current_circuit:
            messagebox.showwarning("No circuit", "Open a circuit first.")
            return
        from .validation import validate_timing, validate_thermal
        t = validate_timing(self._current_circuit)
        h = validate_thermal(self._current_circuit)
        self._log("Validation report:")
        self._log("  " + str(t.summary()).replace("\n", "\n  "))
        self._log("  " + str(h.summary()).replace("\n", "\n  "))

    def on_about(self):
        messagebox.showinfo(
            "About",
            f"{_APP_TITLE} v{_version_string()}\n\n"
            "A circuit design and simulation tool.\n"
            "This GUI is a functional stub; full schematic editing "
            "is a future enhancement.\n\n"
            "See docs/ for the full specification.",
        )

    def _populate_tree(self):
        for iid in self.tree.get_children():
            self.tree.delete(iid)
        if not self._current_circuit:
            return
        for cid, comp in self._current_circuit._components.items():
            self.tree.insert("", tk.END, text=str(int(cid)),
                              values=(comp.reference, comp.spec.name))


def run_gui() -> int:
    """Launch the GUI. Returns 0 on clean exit, 1 if unavailable."""
    if tk is None:
        print("tkinter is not available on this system.")
        return 1
    root = tk.Tk()
    app = CircuitForgeApp(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(run_gui())