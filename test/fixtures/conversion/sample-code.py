#!/usr/bin/env python3
"""Sample Python module for conversion testing."""


class DataProcessor:
    """Processes data records with configurable transforms."""

    def __init__(self, name: str, threshold: float = 0.5):
        self.name = name
        self.threshold = threshold
        self._records: list[dict] = []

    def add_record(self, record: dict) -> None:
        """Add a record to the processor."""
        if not isinstance(record, dict):
            raise TypeError(f"Expected dict, got {type(record).__name__}")
        self._records.append(record)

    def filter(self, key: str, min_value: float) -> list[dict]:
        """Filter records where key >= min_value."""
        return [r for r in self._records if r.get(key, 0) >= min_value]

    @property
    def count(self) -> int:
        """Return the number of stored records."""
        return len(self._records)


def summarize(processor: DataProcessor) -> str:
    """Return a human-readable summary of the processor state."""
    return f"Processor '{processor.name}' has {processor.count} records (threshold={processor.threshold})"


if __name__ == "__main__":
    dp = DataProcessor("demo", threshold=0.7)
    dp.add_record({"score": 0.9, "label": "good"})
    dp.add_record({"score": 0.4, "label": "poor"})
    print(summarize(dp))
    print(f"Filtered (>=0.5): {dp.filter('score', 0.5)}")
