class CreateLeagues < ActiveRecord::Migration
	def change
		create_table :leagues do |t|
			t.string :name, :null => false, :limit => 64
			t.integer :current_season, :null => true, :default => 1
			t.timestamps
		end
	end
end