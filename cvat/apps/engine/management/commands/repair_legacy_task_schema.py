# SPDX-License-Identifier: MIT

from django.core.management.base import BaseCommand
from django.db import connection, transaction

from cvat.apps.engine.models import Task


class Command(BaseCommand):
    help = "Allow this checkout to create tasks in a database with an unused media_type column."

    def handle(self, *args, **options):
        # A newer checkout that owns this field must retain its own constraints.
        if any(field.column == "media_type" for field in Task._meta.local_fields):
            self.stdout.write("Task.media_type is managed by this checkout; no repair needed.")
            return

        with transaction.atomic(), connection.cursor() as cursor:
            columns = connection.introspection.get_table_description(cursor, Task._meta.db_table)
            column = next((column for column in columns if column.name == "media_type"), None)
            if column is None or column.null_ok:
                self.stdout.write("Task schema is compatible; no repair needed.")
                return

            # Keep existing values and migration history. Do not guess the media
            # type for new tasks: this checkout cannot populate the newer field.
            cursor.execute("SET LOCAL lock_timeout = '5s'")
            cursor.execute("ALTER TABLE engine_task ALTER COLUMN media_type DROP NOT NULL")
            self.stdout.write(self.style.SUCCESS("Preserved engine_task.media_type and made it nullable."))
