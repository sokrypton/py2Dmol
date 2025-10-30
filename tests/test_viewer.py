import importlib
from unittest.mock import MagicMock, patch

import numpy as np
import pytest
from gemmi import Residue

from py2Dmol import viewer
from py2Dmol.viewer import View, align_a_to_b, kabsch


def test_kabsch() -> None:
    """Test the kabsch function."""
    a = np.array([[1, 1, 1], [2, 2, 2], [3, 3, 3]])
    b = np.array([[1, 1, 2], [2, 2, 3], [3, 3, 4]])
    r = kabsch(a=a, b=b)
    assert r.shape == (3, 3)


def test_align_a_to_b() -> None:
    """Test the align_a_to_b function."""
    a = np.array([[1, 1, 1], [2, 2, 2], [3, 3, 3]])
    b = np.array([[1, 1, 2], [2, 2, 3], [3, 3, 4]])
    aligned_a = align_a_to_b(a, b)
    assert aligned_a.shape == (3, 3)


@patch("py2Dmol.viewer.display")
@patch("py2Dmol.viewer.HTML")
@patch("py2Dmol.viewer.Javascript")
def test_view_init(mock_js: MagicMock, mock_html: MagicMock, mock_display: MagicMock) -> None:
    """Test the View class initialization."""
    view = View()
    assert view.size == (500, 500)
    assert view.color == "rainbow"


@patch("py2Dmol.viewer.display")
@patch("py2Dmol.viewer.HTML")
@patch("py2Dmol.viewer.Javascript")
def test_view_add(mock_js: MagicMock, mock_html: MagicMock, mock_display: MagicMock) -> None:
    """Test the add method of the View class."""
    view = View()
    coords = np.random.rand(10, 3)
    view.add(coords)
    assert view._coords is not None


@patch("py2Dmol.viewer.display")
@patch("py2Dmol.viewer.HTML")
@patch("py2Dmol.viewer.Javascript")
@patch("gemmi.read_structure")
def test_view_add_pdb(
    mock_read_structure: MagicMock,
    mock_js: MagicMock,
    mock_html: MagicMock,
    mock_display: MagicMock,
) -> None:
    """Test the add_pdb method of the View class."""
    mock_structure = MagicMock()
    mock_model = MagicMock()
    mock_chain = MagicMock()
    mock_residue = MagicMock()
    mock_atom = MagicMock()

    mock_atom.pos.tolist.return_value = [0, 0, 0]
    mock_atom.b_iso = 0
    mock_residue.name = "ALA"
    mock_residue.__contains__.return_value = True
    mock_residue.__getitem__.return_value = [mock_atom]
    mock_chain.name = "A"
    mock_chain.__iter__.return_value = [mock_residue]
    mock_model.__iter__.return_value = [mock_chain]
    mock_structure.__iter__.return_value = [mock_model]
    mock_read_structure.return_value = mock_structure

    view = View()
    view.add_pdb("fake.pdb")

    assert view._coords is not None


@patch("py2Dmol.viewer.display")
@patch("py2Dmol.viewer.HTML")
@patch("py2Dmol.viewer.Javascript")
def test_view_clear(mock_js: MagicMock, mock_html: MagicMock, mock_display: MagicMock) -> None:
    """Test the clear method of the View class."""
    view = View()
    coords = np.random.rand(10, 3)
    view.add(coords)
    view.clear()
    assert view._coords is None


@patch.dict("sys.modules", {"google.colab": MagicMock()})
def test_view_colab() -> None:
    """Test the View class in a Colab environment."""
    importlib.reload(viewer)
    view = viewer.View()
    coords = np.random.rand(10, 3)
    view.add(coords)
    if viewer.colab_output:
        viewer.colab_output.eval_js.assert_called()


def test_process_protein_residue() -> None:
    """Test the _process_protein_residue method."""
    view = View()
    residue = MagicMock(spec=Residue)
    residue.name = "ALA"
    atom = MagicMock()
    atom.pos.tolist.return_value = [0, 0, 0]
    atom.b_iso = 0
    residue.__contains__.return_value = True
    residue.__getitem__.return_value = [atom]
    result = view._process_protein_residue(residue, "A")
    assert result is not None
    assert result["atom_type"] == "P"


def test_process_nucleic_residue() -> None:
    """Test the _process_nucleic_residue method."""
    view = View()
    residue = MagicMock(spec=Residue)
    residue.name = "DA"
    atom = MagicMock()
    atom.pos.tolist.return_value = [0, 0, 0]
    atom.b_iso = 0
    residue.__contains__.return_value = True
    residue.__getitem__.return_value = [atom]
    result = view._process_nucleic_residue(residue, "A")
    assert result is not None
    assert result["atom_type"] == "D"


def test_process_ligand_residue() -> None:
    """Test the _process_ligand_residue method."""
    view = View()
    residue = MagicMock(spec=Residue)
    residue.name = "LIG"
    atom = MagicMock()
    atom.element.name = "C"
    atom.pos.tolist.return_value = [0, 0, 0]
    atom.b_iso = 0
    residue.__iter__.return_value = [atom]
    result = view._process_ligand_residue(residue, "A")
    assert result[0]["atom_type"] == "L"


@patch("gemmi.find_tabulated_residue")
def test_process_residue(mock_find_tabulated_residue: MagicMock) -> None:
    """Test the _process_residue method."""
    view = View()
    residue = MagicMock(spec=Residue)
    residue.name = "HOH"
    assert view._process_residue(residue, "A") is None

    residue.name = "ALA"
    mock_find_tabulated_residue.return_value.is_amino_acid.return_value = True
    with patch.object(view, "_process_protein_residue") as mock_process:
        view._process_residue(residue, "A")
        mock_process.assert_called()
