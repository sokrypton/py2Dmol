"""
py2Dmol/grid.py
---------------
Grid layout support for displaying multiple py2Dmol viewers.

Provides three usage patterns:
1. Context manager: with py2Dmol.grid(cols=2) as g: ...
2. Explicit builder: grid = py2Dmol.Grid(...); grid.show()
3. Function-based: py2Dmol.show_grid([viewers], cols=2)
"""

from IPython.display import display, HTML
import re


class Grid:
    """
    Grid layout manager for displaying multiple py2Dmol viewers in a grid.

    Supports both context manager and explicit usage patterns.

    Examples:
        # Context manager style:
        with py2Dmol.grid(cols=2) as g:
            g.view().from_pdb('1YNE')
            g.view(rotate=True).from_pdb('1BJP')

        # Explicit style:
        grid = py2Dmol.Grid(cols=2, size=(300, 300))
        grid.view().from_pdb('1YNE')
        grid.view(rotate=True).from_pdb('1BJP')
        grid.show()
    """

    def __init__(self, cols=2, rows=None, gap=5, size=None, controls=False, box=False):
        """
        Create a grid layout for multiple viewers.

        Args:
            cols (int): Number of columns (default: 2)
            rows (int, optional): Number of rows (auto-calculated if None)
            gap (int): Gap between viewers in pixels (default: 5)
            size (tuple, optional): Default size for each viewer as (width, height).
                                   Can be overridden per-viewer. Default: (400, 400)
            controls (bool): Default controls setting for all viewers in grid.
                           Individual viewers can override. Default: False (clean gallery style)
            box (bool): Default box setting for all viewers in grid.
                       Individual viewers can override. Default: False (minimal borders)
        """
        self.cols = cols
        self.rows = rows
        self.gap = gap
        self.default_size = size or (400, 400)
        self.default_controls = controls
        self.default_box = box
        self.viewers = []
        self._auto_show = False  # Track if we should auto-show on __exit__

    def __enter__(self):
        """Enter context manager mode."""
        self._auto_show = True
        return self

    def __exit__(self, *args):
        """Exit context manager and display grid."""
        if self._auto_show:
            self.show()

    def view(self, **kwargs):
        """
        Create a new viewer with grid defaults and add it to the grid.

        IMPORTANT: This method sets the viewer's _is_live flag to True to prevent
        from_pdb() and from_afdb() from auto-showing the viewer before the grid
        has a chance to collect it.

        Grid defaults (size, controls, box) are applied unless explicitly overridden
        in kwargs.

        Args:
            **kwargs: Arguments passed to py2Dmol.view()

        Returns:
            view: The created viewer instance (for method chaining)

        Example:
            # Use grid defaults
            grid.view().from_pdb('1YNE')

            # Override specific defaults
            grid.view(controls=True, size=(500, 500)).from_pdb('1BJP')
        """
        # Import here to avoid circular dependency
        from .viewer import view as create_view

        # Apply grid defaults if not explicitly specified
        if 'size' not in kwargs:
            kwargs['size'] = self.default_size
        if 'controls' not in kwargs:
            kwargs['controls'] = self.default_controls
        if 'box' not in kwargs:
            kwargs['box'] = self.default_box

        # Create viewer instance
        viewer = create_view(**kwargs)

        # Mark viewer as "live" so from_pdb()/from_afdb() won't auto-show.
        # Setting _is_live=True tells the viewer it's managed externally (by the grid).
        # Users can still force display with from_pdb(..., show=True) if needed.
        viewer._is_live = True

        self.viewers.append(viewer)
        return viewer

    def add_viewer(self, viewer):
        """
        Add an existing viewer instance to the grid.

        Note: If the viewer has already been shown individually, this will
        include it in the grid. If not, the grid will display it.

        Args:
            viewer: A py2Dmol.view instance

        Returns:
            self: For method chaining
        """
        self.viewers.append(viewer)
        return self

    def show(self):
        """
        Display all viewers in the grid layout.

        Generates a single HTML output with CSS Grid layout containing
        all viewers. JavaScript libraries are loaded only once for efficiency.

        Technical details:
        - First viewer loads JS libraries (viewer-mol.js, viewer-pae.js if needed)
        - Subsequent viewers reuse loaded libraries via browser caching
        - Each viewer gets its own canvas and unique ID
        - Viewers can have independent configurations and controls
        """
        if not self.viewers:
            print("Warning: No viewers to display in grid.")
            return

        # Calculate rows if not specified
        rows = self.rows or ((len(self.viewers) + self.cols - 1) // self.cols)

        # Generate HTML for each viewer
        viewer_htmls = []
        first_viewer = True

        for viewer in self.viewers:
            # Get viewer HTML with static data
            # This bypasses the normal show() method to avoid individual display
            static_data = viewer.objects if viewer.objects else None

            # Only first viewer includes library scripts, subsequent ones reuse via global scope
            html = viewer._display_viewer(static_data=static_data, include_libs=first_viewer)

            first_viewer = False
            viewer_htmls.append(html)

        # Build grid container HTML
        grid_html = f"""
<style>
    .py2dmol-grid {{
        display: grid;
        grid-template-columns: repeat({self.cols}, auto);
        gap: {self.gap}px;
        row-gap: {self.gap}px;
        column-gap: {self.gap}px;
        width: fit-content;
        align-items: start;
    }}
    .py2dmol-grid-item {{
        display: inline-block;
    }}
    /* Remove viewer padding and gap in grid context for tighter layout */
    .py2dmol-grid-item #mainContainer {{
        padding: 0;
        gap: 0;
        margin: 0;
    }}
    .py2dmol-grid-item #viewerWrapper {{
        gap: 0;
        margin: 0;
    }}
</style>
<div class="py2dmol-grid">
"""

        # Add each viewer as a grid item
        for html in viewer_htmls:
            grid_html += f'    <div class="py2dmol-grid-item">{html}</div>\n'

        grid_html += "</div>"

        # Display using IPython
        display(HTML(grid_html))


def grid(cols=2, rows=None, gap=5, size=None, controls=False, box=False):
    """
    Create a grid context manager for displaying multiple viewers.

    This is a convenience function that creates a Grid instance
    for use with the context manager pattern.

    Args:
        cols (int): Number of columns (default: 2)
        rows (int, optional): Number of rows (auto-calculated if None)
        gap (int): Gap between viewers in pixels (default: 5)
        size (tuple, optional): Default size for each viewer as (width, height)
        controls (bool): Default controls setting for all viewers (default: False)
        box (bool): Default box setting for all viewers (default: False)

    Returns:
        Grid: A Grid instance for use in a 'with' statement

    Examples:
        # Clean gallery (default - no controls/boxes)
        with py2Dmol.grid(cols=4) as g:
            for pdb_id in ['1YNE', '1BJP', '9D2J', '2BEG']:
                g.view().from_pdb(pdb_id)

        # With controls (override grid default)
        with py2Dmol.grid(cols=2, controls=True, box=True) as g:
            g.view().from_pdb('1YNE')
            g.view(rotate=True).from_pdb('1BJP')

        # Mixed (grid default off, but enable for one viewer)
        with py2Dmol.grid(cols=3) as g:
            g.view().from_pdb('1YNE')              # No controls
            g.view(controls=True).from_pdb('1BJP') # With controls
            g.view().from_pdb('9D2J')              # No controls
    """
    return Grid(cols=cols, rows=rows, gap=gap, size=size, controls=controls, box=box)


def show_grid(viewers, cols=2, gap=5):
    """
    Display a list of viewers in a grid layout.

    This is a convenience function for displaying pre-created viewers
    in a grid without using the Grid class directly.

    Note: If viewers have not been shown individually yet, this will
    display them for the first time in the grid. If they have already
    been shown, this creates a new grid view of them.

    Args:
        viewers (list): List of py2Dmol.view instances
        cols (int): Number of columns (default: 2)
        gap (int): Gap between viewers in pixels (default: 5)

    Example:
        v1 = py2Dmol.view()
        v1.add_pdb('1YNE')

        v2 = py2Dmol.view(rotate=True)
        v2.add_pdb('1BJP')

        py2Dmol.show_grid([v1, v2], cols=2)
    """
    g = Grid(cols=cols, gap=gap)
    for viewer in viewers:
        g.add_viewer(viewer)
    g.show()
