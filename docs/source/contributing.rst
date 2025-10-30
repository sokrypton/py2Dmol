Contributing
============

We welcome contributions to py2Dmol! This page provides guidelines for contributing to the project.

Getting Started
---------------

1. Fork the repository on GitHub
2. Clone your fork locally:

.. code-block:: bash

   git clone https://github.com/YOUR_USERNAME/py2Dmol.git
   cd py2Dmol

3. Install the package in development mode with all dependencies:

.. code-block:: bash

   pip install -e ".[dev,tests,docs]"

4. Install pre-commit hooks:

.. code-block:: bash

   pre-commit install

Development Workflow
--------------------

1. Create a new branch for your feature or bugfix:

.. code-block:: bash

   git checkout -b feature-name

2. Make your changes and ensure they follow the code style
3. Write or update tests as needed
4. Run the test suite:

.. code-block:: bash

   pytest

5. Check code coverage:

.. code-block:: bash

   pytest --cov=py2dmol --cov-report=html

6. Commit your changes:

.. code-block:: bash

   git add .
   git commit -m "Description of changes"

7. Push to your fork:

.. code-block:: bash

   git push origin feature-name

8. Open a pull request on GitHub

Code Style
----------

This project uses:

- **ruff** for linting and formatting
- **basedpyright** for type checking
- **pre-commit** for automated checks

The code style is enforced by pre-commit hooks. To manually run formatting:

.. code-block:: bash

   ruff format .
   ruff check --fix .

Running Tests
-------------

Run all tests:

.. code-block:: bash

   pytest

Run with coverage:

.. code-block:: bash

   pytest --cov=py2dmol --cov-report=html

View the coverage report:

.. code-block:: bash

   open htmlcov/index.html  # macOS
   xdg-open htmlcov/index.html  # Linux
   start htmlcov/index.html  # Windows

Building Documentation
----------------------

To build the documentation locally:

.. code-block:: bash

   cd docs
   make html

View the documentation:

.. code-block:: bash

   open build/html/index.html  # macOS
   xdg-open build/html/index.html  # Linux
   start build/html/index.html  # Windows

For live-reload during development:

.. code-block:: bash

   sphinx-autobuild source build/html

Then open http://127.0.0.1:8000 in your browser.

Pull Request Guidelines
-----------------------

Before submitting a pull request:

1. Ensure all tests pass
2. Add tests for new features
3. Update documentation as needed
4. Ensure code coverage doesn't decrease
5. Follow the existing code style
6. Write clear commit messages
7. Update the CHANGELOG if applicable

Code Review Process
-------------------

1. A maintainer will review your pull request
2. Address any feedback or requested changes
3. Once approved, a maintainer will merge your PR

Reporting Issues
----------------

If you find a bug or have a feature request:

1. Check if an issue already exists
2. If not, create a new issue with:
   - A clear title and description
   - Steps to reproduce (for bugs)
   - Expected vs actual behavior
   - Your environment (Python version, OS, etc.)
   - Any relevant code snippets or error messages

License
-------

By contributing to py2Dmol, you agree that your contributions will be licensed under the BEER-WARE license.

Questions?
----------

If you have questions about contributing, feel free to:

- Open an issue on GitHub
- Reach out to the maintainers

Thank you for contributing to py2Dmol! 🎉
