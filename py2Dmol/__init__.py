# THE VERSION LIVES HERE AND NOWHERE ELSE. setup.py reads this file rather
# than carrying a second copy - two numbers that must agree are two numbers
# that can disagree, and the wheel is where you find out.
__version__ = "2.0.0"

from .viewer import view
from .grid import Grid, grid, show_grid
