CREATE TABLE `content_source_url_captures` (
	`source_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`requested_url` text NOT NULL,
	`resolved_url` text,
	`http_status` integer,
	`redirect_count` integer NOT NULL,
	`fetch_attempted` integer NOT NULL,
	`response_complete` integer NOT NULL,
	`text_truncated` integer NOT NULL,
	`extracted_bytes` integer NOT NULL,
	FOREIGN KEY (`project_id`,`source_id`) REFERENCES `content_sources`(`project_id`,`id`) ON UPDATE no action ON DELETE cascade
);
