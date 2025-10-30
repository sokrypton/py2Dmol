import importlib
from unittest.mock import MagicMock, patch

import numpy as np
import pytest
from gemmi import Residue

from py2dmol import viewer
from py2dmol.viewer import View, align_a_to_b, kabsch


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


@patch("py2dmol.viewer.display")
@patch("py2dmol.viewer.HTML")
@patch("py2dmol.viewer.Javascript")
def test_view_init(mock_js: MagicMock, mock_html: MagicMock, mock_display: MagicMock) -> None:
    """Test the View class initialization."""
    view = View()
    assert view.size == (500, 500)
    assert view._initial_color_mode == "auto"
    assert view._resolved_color_mode == "auto"


@patch("py2dmol.viewer.display")
@patch("py2dmol.viewer.HTML")
@patch("py2dmol.viewer.Javascript")
def test_view_add(mock_js: MagicMock, mock_html: MagicMock, mock_display: MagicMock) -> None:
    """Test the add method of the View class."""
    view = View()
    coords = np.random.rand(10, 3)
    view.add(coords)
    assert view._coords is not None


@patch("py2dmol.viewer.display")
@patch("py2dmol.viewer.HTML")
@patch("py2dmol.viewer.Javascript")
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


@patch("py2dmol.viewer.display")
@patch("py2dmol.viewer.HTML")
@patch("py2dmol.viewer.Javascript")
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


@patch("py2dmol.viewer.display")
@patch("py2dmol.viewer.HTML")
@patch("py2dmol.viewer.Javascript")
def test_view_auto_color_single_chain(mock_js: MagicMock, mock_html: MagicMock, mock_display: MagicMock) -> None:
    """Test auto color mode with single chain."""
    view = View(color="auto")
    coords = np.random.rand(10, 3)
    chains = ["A"] * 10
    view.add(coords, chains=chains)
    assert view._resolved_color_mode == "rainbow"


@patch("py2dmol.viewer.display")
@patch("py2dmol.viewer.HTML")
@patch("py2dmol.viewer.Javascript")
def test_view_auto_color_multiple_chains(mock_js: MagicMock, mock_html: MagicMock, mock_display: MagicMock) -> None:
    """Test auto color mode with multiple chains."""
    view = View(color="auto")
    coords = np.random.rand(10, 3)
    chains = ["A"] * 5 + ["B"] * 5
    view.add(coords, chains=chains)
    assert view._resolved_color_mode == "chain"


@patch("py2dmol.viewer.display")
@patch("py2dmol.viewer.HTML")
@patch("py2dmol.viewer.Javascript")
def test_view_auto_color_no_chains(mock_js: MagicMock, mock_html: MagicMock, mock_display: MagicMock) -> None:
    """Test auto color mode with no chains provided."""
    view = View(color="auto")
    coords = np.random.rand(10, 3)
    view.add(coords)
    assert view._resolved_color_mode == "rainbow"


@patch("py2dmol.viewer.display")
@patch("py2dmol.viewer.HTML")
@patch("py2dmol.viewer.Javascript")
def test_view_explicit_color_mode(mock_js: MagicMock, mock_html: MagicMock, mock_display: MagicMock) -> None:
    """Test explicit color mode."""
    view = View(color="chain")
    coords = np.random.rand(10, 3)
    view.add(coords)
    assert view._resolved_color_mode == "chain"


@patch("py2dmol.viewer.display")
@patch("py2dmol.viewer.HTML")
@patch("py2dmol.viewer.Javascript")
def test_view_length_mismatch_warnings(mock_js: MagicMock, mock_html: MagicMock, mock_display: MagicMock) -> None:
    """Test length mismatch warnings."""
    view = View()
    coords = np.random.rand(10, 3)
    
    # Add first frame
    view.add(coords)
    
    # Add second frame with mismatched plddts
    coords2 = np.random.rand(10, 3)
    plddts2 = np.array([50.0, 60.0])  # Wrong length
    chains2 = ["A", "B"]  # Wrong length
    atom_types2 = ["P", "P"]  # Wrong length
    
    with patch("py2dmol.viewer.logger") as mock_logger:
        view.add(coords2, plddts=plddts2, chains=chains2, atom_types=atom_types2)
        assert mock_logger.warning.call_count == 3


@patch("py2dmol.viewer.display")
@patch("py2dmol.viewer.HTML")
@patch("py2dmol.viewer.Javascript")
def test_view_new_traj(mock_js: MagicMock, mock_html: MagicMock, mock_display: MagicMock) -> None:
    """Test new_traj method."""
    view = View()
    coords = np.random.rand(10, 3)
    
    # Add first trajectory
    view.add(coords)
    
    # Start new trajectory
    view.new_traj("trajectory_1")
    assert view._current_trajectory_name == "trajectory_1"
    assert view._coords is None  # Reset after new trajectory


@patch("py2dmol.viewer.display")
@patch("py2dmol.viewer.HTML")
@patch("py2dmol.viewer.Javascript")
def test_view_add_with_new_traj(mock_js: MagicMock, mock_html: MagicMock, mock_display: MagicMock) -> None:
    """Test add method with new_traj parameter."""
    view = View()
    coords1 = np.random.rand(10, 3)
    coords2 = np.random.rand(10, 3)
    
    # Add first trajectory
    view.add(coords1)
    
    # Add second trajectory with custom name
    view.add(coords2, new_traj=True, trajectory_name="custom_traj")
    assert view._current_trajectory_name == "custom_traj"


@patch("py2dmol.viewer.display")
@patch("py2dmol.viewer.HTML")
@patch("py2dmol.viewer.Javascript")
def test_view_add_with_new_traj_no_name(mock_js: MagicMock, mock_html: MagicMock, mock_display: MagicMock) -> None:
    """Test add method with new_traj but no trajectory name."""
    view = View()
    coords1 = np.random.rand(10, 3)
    coords2 = np.random.rand(10, 3)
    
    # Add first trajectory
    view.add(coords1)
    
    # Add second trajectory without custom name
    view.add(coords2, new_traj=True)
    assert view._current_trajectory_name == "1"


@patch("py2dmol.viewer.display")
@patch("py2dmol.viewer.HTML")
@patch("py2dmol.viewer.Javascript")
@patch("gemmi.read_structure")
def test_view_from_pdb(
    mock_read_structure: MagicMock,
    mock_js: MagicMock,
    mock_html: MagicMock,
    mock_display: MagicMock,
) -> None:
    """Test the from_pdb method."""
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
    view.from_pdb("fake.pdb")

    assert view._coords is not None


@patch("py2dmol.viewer.display")
@patch("py2dmol.viewer.HTML")
@patch("py2dmol.viewer.Javascript")
@patch("gemmi.read_structure")
def test_view_add_pdb_with_specific_chains(
    mock_read_structure: MagicMock,
    mock_js: MagicMock,
    mock_html: MagicMock,
    mock_display: MagicMock,
) -> None:
    """Test add_pdb with specific chains."""
    mock_structure = MagicMock()
    mock_model = MagicMock()
    mock_chain_a = MagicMock()
    mock_chain_b = MagicMock()
    mock_residue = MagicMock()
    mock_atom = MagicMock()

    mock_atom.pos.tolist.return_value = [0, 0, 0]
    mock_atom.b_iso = 0
    mock_residue.name = "ALA"
    mock_residue.__contains__.return_value = True
    mock_residue.__getitem__.return_value = [mock_atom]
    
    mock_chain_a.name = "A"
    mock_chain_a.__iter__.return_value = [mock_residue]
    mock_chain_b.name = "B"
    mock_chain_b.__iter__.return_value = [mock_residue]
    
    mock_model.__iter__.return_value = [mock_chain_a, mock_chain_b]
    mock_structure.__iter__.return_value = [mock_model]
    mock_read_structure.return_value = mock_structure

    view = View()
    view.add_pdb("fake.pdb", chains=["A"])

    assert view._coords is not None


@patch("py2dmol.viewer.display")
@patch("py2dmol.viewer.HTML")
@patch("py2dmol.viewer.Javascript")
@patch("gemmi.read_structure")
def test_view_add_pdb_multi_model(
    mock_read_structure: MagicMock,
    mock_js: MagicMock,
    mock_html: MagicMock,
    mock_display: MagicMock,
) -> None:
    """Test add_pdb with multiple models."""
    mock_structure = MagicMock()
    mock_model1 = MagicMock()
    mock_model2 = MagicMock()
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
    mock_model1.__iter__.return_value = [mock_chain]
    mock_model2.__iter__.return_value = [mock_chain]
    mock_structure.__iter__.return_value = [mock_model1, mock_model2]
    mock_read_structure.return_value = mock_structure

    view = View()
    view.add_pdb("fake.pdb", new_traj=True, trajectory_name="multi_model")

    assert view._coords is not None


def test_get_data_dict_empty() -> None:
    """Test _get_data_dict with empty data."""
    view = View()
    data = view._get_data_dict()
    assert data == {"coords": [], "plddts": [], "chains": [], "atom_types": []}


@patch("py2dmol.viewer.display")
@patch("py2dmol.viewer.HTML")
@patch("py2dmol.viewer.Javascript")
def test_view_initialization_with_all_params(mock_js: MagicMock, mock_html: MagicMock, mock_display: MagicMock) -> None:
    """Test View initialization with all parameters."""
    view = View(
        size=(600, 400),
        color="chain",
        shadow=False,
        outline=False,
        width=5.0,
        rotate=True
    )
    assert view.size == (600, 400)
    assert view._initial_color_mode == "chain"
    assert view._initial_shadow_enabled is False
    assert view._initial_outline_enabled is False
    assert view._initial_width == 5.0
    assert view._initial_rotate is True


def test_process_nucleic_residue_c4star() -> None:
    """Test _process_nucleic_residue with C4* atom."""
    view = View()
    residue = MagicMock(spec=Residue)
    residue.name = "DA"
    atom = MagicMock()
    atom.pos.tolist.return_value = [0, 0, 0]
    atom.b_iso = 0
    
    # Test with C4*
    residue.__contains__.side_effect = lambda x: x == "C4*"
    residue.__getitem__.return_value = [atom]
    
    result = view._process_nucleic_residue(residue, "A")
    assert result is not None
    assert result["atom_type"] == "D"


def test_process_nucleic_residue_rna() -> None:
    """Test _process_nucleic_residue with RNA bases."""
    view = View()
    residue = MagicMock(spec=Residue)
    atom = MagicMock()
    atom.pos.tolist.return_value = [0, 0, 0]
    atom.b_iso = 0
    
    # Test with RNA base
    residue.name = "RA"
    residue.__contains__.side_effect = lambda x: x == "C4'"
    residue.__getitem__.return_value = [atom]
    
    result = view._process_nucleic_residue(residue, "A")
    assert result is not None
    assert result["atom_type"] == "R"


def test_process_protein_residue_no_ca() -> None:
    """Test _process_protein_residue without CA atom."""
    view = View()
    residue = MagicMock(spec=Residue)
    residue.name = "ALA"
    residue.__contains__.return_value = False
    
    result = view._process_protein_residue(residue, "A")
    assert result is None


def test_process_nucleic_residue_no_c4() -> None:
    """Test _process_nucleic_residue without C4' or C4* atom."""
    view = View()
    residue = MagicMock(spec=Residue)
    residue.name = "DA"
    residue.__contains__.return_value = False
    
    result = view._process_nucleic_residue(residue, "A")
    assert result is None


@patch("gemmi.find_tabulated_residue")
def test_process_residue_nucleic_acid(mock_find_tabulated_residue: MagicMock) -> None:
    """Test _process_residue with nucleic acid."""
    view = View()
    residue = MagicMock(spec=Residue)
    residue.name = "DA"
    atom = MagicMock()
    atom.pos.tolist.return_value = [0, 0, 0]
    atom.b_iso = 0
    
    residue.__contains__.side_effect = lambda x: x == "C4'"
    residue.__getitem__.return_value = [atom]
    
    mock_find_tabulated_residue.return_value.is_amino_acid.return_value = False
    mock_find_tabulated_residue.return_value.is_nucleic_acid.return_value = True
    
    result = view._process_residue(residue, "A")
    assert result is not None
    assert result["atom_type"] == "D" # pyright: ignore[reportArgumentType, reportCallIssue]


@patch("gemmi.find_tabulated_residue")
def test_process_residue_ligand(mock_find_tabulated_residue: MagicMock) -> None:
    """Test _process_residue with ligand."""
    view = View()
    residue = MagicMock(spec=Residue)
    residue.name = "HEM"
    atom = MagicMock()
    atom.element.name = "C"
    atom.pos.tolist.return_value = [0, 0, 0]
    atom.b_iso = 0
    residue.__iter__.return_value = [atom]
    
    mock_find_tabulated_residue.return_value.is_amino_acid.return_value = False
    mock_find_tabulated_residue.return_value.is_nucleic_acid.return_value = False
    
    result = view._process_residue(residue, "A")
    assert isinstance(result, list)
    assert len(result) > 0
    assert result[0]["atom_type"] == "L"


@patch("py2dmol.viewer.display")
@patch("py2dmol.viewer.HTML")
@patch("py2dmol.viewer.Javascript")
@patch("gemmi.read_structure")
def test_view_add_pdb_skips_water(
    mock_read_structure: MagicMock,
    mock_js: MagicMock,
    mock_html: MagicMock,
    mock_display: MagicMock,
) -> None:
    """Test add_pdb skips water residues."""
    mock_structure = MagicMock()
    mock_model = MagicMock()
    mock_chain = MagicMock()
    mock_residue_water = MagicMock()
    mock_residue_protein = MagicMock()
    mock_atom = MagicMock()

    mock_atom.pos.tolist.return_value = [0, 0, 0]
    mock_atom.b_iso = 0
    
    mock_residue_water.name = "HOH"
    
    mock_residue_protein.name = "ALA"
    mock_residue_protein.__contains__.return_value = True
    mock_residue_protein.__getitem__.return_value = [mock_atom]
    
    mock_chain.name = "A"
    mock_chain.__iter__.return_value = [mock_residue_water, mock_residue_protein]
    mock_model.__iter__.return_value = [mock_chain]
    mock_structure.__iter__.return_value = [mock_model]
    mock_read_structure.return_value = mock_structure

    view = View()
    view.add_pdb("fake.pdb")

    # Should have only 1 coordinate (protein), not 2 (protein + water)
    assert view._coords is not None
    assert len(view._coords) == 1


@patch("py2dmol.viewer.importlib.resources.open_text")
@patch("py2dmol.viewer.display")
@patch("py2dmol.viewer.HTML")
@patch("py2dmol.viewer.Javascript")
def test_display_viewer_file_not_found(
    mock_js: MagicMock,
    mock_html: MagicMock,
    mock_display: MagicMock,
    mock_open_text: MagicMock,
) -> None:
    """Test _display_viewer handles FileNotFoundError."""
    mock_open_text.side_effect = FileNotFoundError("Template not found")
    
    view = View()
    with patch("py2dmol.viewer.logger") as mock_logger:
        view._display_viewer()
        mock_logger.exception.assert_called_once()


@patch.dict("sys.modules", {"google.colab": MagicMock()})
def test_send_colab_message_exception() -> None:
    """Test _send_colab_message handles exceptions."""
    importlib.reload(viewer)
    
    view = viewer.View()
    coords = np.random.rand(10, 3)
    view.add(coords)
    
    # Mock colab_output to raise an exception
    if viewer.colab_output:
        viewer.colab_output.eval_js.side_effect = Exception("Colab error")
        
        with patch("py2dmol.viewer.logger") as mock_logger:
            view._send_colab_message({"type": "py2DmolUpdate", "payload": {}})
            mock_logger.exception.assert_called()


@patch.dict("sys.modules", {"google.colab": MagicMock()})
def test_colab_message_types() -> None:
    """Test different message types in Colab environment."""
    importlib.reload(viewer)
    
    if viewer.colab_output:
        view = viewer.View()
        coords = np.random.rand(5, 3)
        view.add(coords)
        
        # Test py2DmolNewTrajectory message
        view._send_colab_message({"type": "py2DmolNewTrajectory", "name": "test_traj"})
        
        # Test py2DmolClearAll message
        view._send_colab_message({"type": "py2DmolClearAll"})
        
        # Verify eval_js was called
        assert viewer.colab_output.eval_js.called


@patch("py2dmol.viewer.display")
@patch("py2dmol.viewer.HTML")
@patch("py2dmol.viewer.Javascript")
@patch("gemmi.read_structure")
def test_view_add_pdb_mixed_residues(
    mock_read_structure: MagicMock,
    mock_js: MagicMock,
    mock_html: MagicMock,
    mock_display: MagicMock,
) -> None:
    """Test add_pdb with mixed protein and ligand residues."""
    mock_structure = MagicMock()
    mock_model = MagicMock()
    mock_chain = MagicMock()
    
    # Protein residue
    mock_residue_protein = MagicMock()
    mock_atom_ca = MagicMock()
    mock_atom_ca.pos.tolist.return_value = [1, 1, 1]
    mock_atom_ca.b_iso = 80
    mock_residue_protein.name = "ALA"
    mock_residue_protein.__contains__.return_value = True
    mock_residue_protein.__getitem__.return_value = [mock_atom_ca]
    
    # Ligand residue (returns list)
    mock_residue_ligand = MagicMock()
    mock_atom_ligand = MagicMock()
    mock_atom_ligand.element.name = "C"
    mock_atom_ligand.pos.tolist.return_value = [2, 2, 2]
    mock_atom_ligand.b_iso = 60
    mock_residue_ligand.name = "HEM"
    mock_residue_ligand.__iter__.return_value = [mock_atom_ligand]
    
    mock_chain.name = "A"
    mock_chain.__iter__.return_value = [mock_residue_protein, mock_residue_ligand]
    mock_model.__iter__.return_value = [mock_chain]
    mock_structure.__iter__.return_value = [mock_model]
    mock_read_structure.return_value = mock_structure

    view = View()
    
    # Mock the _process_residue to return correct types
    with patch.object(view, "_process_residue") as mock_process:
        # First call returns dict (protein), second returns list (ligand)
        mock_process.side_effect = [
            {"coord": [1, 1, 1], "plddt": 80, "chain": "A", "atom_type": "P"},
            [{"coord": [2, 2, 2], "plddt": 60, "chain": "A", "atom_type": "L"}]
        ]
        
        view.add_pdb("fake.pdb")
        
        # Should have 2 coordinates (1 protein + 1 ligand)
        assert view._coords is not None
        assert len(view._coords) == 2
